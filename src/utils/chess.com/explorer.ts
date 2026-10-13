import { fetch } from "@tauri-apps/plugin-http";
import { z } from "zod";
import type { NormalizedGame } from "@/bindings";
import { parsePGN } from "@/utils/chess";
import type { Opening } from "@/utils/db";
import { apiHeaders } from "@/utils/http";
import { countMainPly } from "@/utils/treeReducer";
import { getChesscomGame } from "./api";

const EXPLORE_METHOD =
  "chesscom.all_games_explorer.v1.AllGamesExplorerService/Explore";

/** Same-domain first (session cookie), then the platform host from the proto. Not api.chess.com/rpc. */
export const CHESSCOM_EXPLORER_URLS = [
  `https://www.chess.com/service/all-games-explorer/${EXPLORE_METHOD}`,
  `https://prod.chess-platform.com/service/all-games-explorer/${EXPLORE_METHOD}`,
] as const;

export const CHESSCOM_EXPLORER_URL = CHESSCOM_EXPLORER_URLS[0];

export const chessComTimeClass = z.enum(["bullet", "blitz", "rapid", "daily"]);
export type ChessComTimeClass = z.infer<typeof chessComTimeClass>;

/** chesscom.chess.v1.TimeClass — numbers so protojson cannot reject name variants. */
const TIME_CLASS_PROTO: Record<ChessComTimeClass, number> = {
  bullet: 2,
  blitz: 3,
  rapid: 4,
  daily: 6,
};

export const chessComGamesOptionsSchema = z.object({
  timeClasses: z.array(chessComTimeClass).min(1),
  minRating: z.number().int().min(0).max(4000).optional(),
  maxRating: z.number().int().min(0).max(4000).optional(),
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
  sessionCookie: z.string().optional(),
});

export type ChessComGamesOptions = z.infer<typeof chessComGamesOptionsSchema>;

export const DEFAULT_CHESSCOM_OPTIONS: ChessComGamesOptions = {
  timeClasses: ["blitz", "rapid"],
  minRating: 1200,
  maxRating: 1800,
};

const int64 = z.coerce.number().int().nonnegative().catch(0);

const perMoveStatsSchema = z.object({
  moveSan: z.string(),
  numGamesPlayed: int64.optional(),
  numWhiteWins: int64.optional(),
  numBlackWins: int64.optional(),
  numDraws: int64.optional(),
});

const exploreResponseSchema = z.object({
  perMoveResponse: z.array(perMoveStatsSchema).optional().default([]),
});

export type ChessComExploreResponse = z.infer<typeof exploreResponseSchema>;

export const chessComSampleGameSchema = z.object({
  url: z.string(),
});

const cache = new Map<string, { openings: Opening[]; games: NormalizedGame[] }>();
let requestSeq = 0;

export function resetChessComExplorerCache() {
  cache.clear();
  requestSeq = 0;
}

export function explorerCacheKey(fen: string, options: ChessComGamesOptions): string {
  const { sessionCookie: _cookie, ...filters } = options;
  return JSON.stringify({
    fen,
    timeClasses: [...filters.timeClasses].sort(),
    minRating: filters.minRating,
    maxRating: filters.maxRating,
    since: filters.since?.toISOString(),
    until: filters.until?.toISOString(),
  });
}

function toProtoDate(date: Date) {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  };
}

function sideToMoveColor(fen: string): 1 | 2 {
  return fen.split(" ")[1] === "b" ? 2 : 1;
}

export function buildExploreRequest(fen: string, options: ChessComGamesOptions) {
  const body: {
    fen: string;
    color: 1 | 2;
    timeClasses: number[];
    includeEvals: boolean;
    ratingBand?: { minRating?: number; maxRating?: number };
    dateBand?: { startDate?: ReturnType<typeof toProtoDate>; endDate?: ReturnType<typeof toProtoDate> };
  } = {
    fen,
    color: sideToMoveColor(fen),
    timeClasses: options.timeClasses.map((tc) => TIME_CLASS_PROTO[tc]),
    includeEvals: false,
  };

  const minRating = options.minRating;
  const maxRating = options.maxRating;
  const hasMin = minRating != null && minRating > 0;
  const hasMax = maxRating != null && maxRating < 4000;
  if (hasMin || hasMax) {
    body.ratingBand = {
      ...(hasMin ? { minRating } : {}),
      ...(hasMax ? { maxRating } : {}),
    };
  }

  if (options.since || options.until) {
    body.dateBand = {
      ...(options.since ? { startDate: toProtoDate(options.since) } : {}),
      ...(options.until ? { endDate: toProtoDate(options.until) } : {}),
    };
  }

  return body;
}

export function parseExploreResponse(data: unknown): ChessComExploreResponse {
  return exploreResponseSchema.parse(data);
}

export function mapExploreToOpenings(data: ChessComExploreResponse): Opening[] {
  return data.perMoveResponse
    .map((move) => ({
      move: move.moveSan,
      white: move.numWhiteWins ?? 0,
      black: move.numBlackWins ?? 0,
      draw: move.numDraws ?? 0,
    }))
    .sort((a, b) => b.white + b.black + b.draw - (a.white + a.black + a.draw));
}

export function cookieHeader(sessionCookie: string): string {
  let trimmed = sessionCookie.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  if (/^cookie:\s*/i.test(trimmed)) {
    trimmed = trimmed.replace(/^cookie:\s*/i, "").trim();
  }
  if (trimmed.toLowerCase().startsWith("phpsessid=") || trimmed.includes("=")) {
    return trimmed;
  }
  return `PHPSESSID=${trimmed}`;
}

function cookiePair(cookie: string, name: string): string | undefined {
  const prefix = `${name}=`;
  for (const part of cookie.split(";")) {
    const piece = part.trim();
    if (piece.startsWith(prefix)) {
      const value = piece.slice(prefix.length).trim();
      if (value) {
        return value;
      }
    }
  }
  return undefined;
}

function explorerHeaders(sessionCookie: string): Record<string, string> {
  const cookie = cookieHeader(sessionCookie);
  const headers = apiHeaders({
    Accept: "application/json",
    "Content-Type": "application/json",
    "Connect-Protocol-Version": "1",
    Origin: "https://www.chess.com",
    Referer: "https://www.chess.com/explorer",
    Cookie: cookie,
  });
  const accessToken = cookiePair(cookie, "ACCESS_TOKEN");
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  return headers;
}

async function errorDetail(res: Response): Promise<string> {
  const text = (await res.text().catch(() => "")).trim();
  if (!text) {
    return "";
  }
  if (text.startsWith("{")) {
    try {
      const json = JSON.parse(text) as { message?: string; code?: string | number };
      const parts = [json.code, json.message].filter((part) => part != null && part !== "");
      if (parts.length > 0) {
        return parts.join(": ");
      }
    } catch {
      /* ignore non-JSON */
    }
  }
  if (/cloudflare|attention required|just a moment|cf-error/i.test(text)) {
    return "blocked by Cloudflare";
  }
  return "";
}

async function throwExplorerHttpError(res: Response): Promise<never> {
  const detail = await errorDetail(res);
  const suffix = detail ? ` (${detail})` : "";
  if (res.status === 403) {
    throw new Error(
      `Chess.com explorer returned 403 Forbidden${suffix}. Paste the full Cookie header from a logged-in chess.com tab (DevTools → Network → Cookie). PHPSESSID alone is often not enough.`,
    );
  }
  if (res.status === 429) {
    throw new Error(`Chess.com explorer returned 429 Too Many Requests${suffix}. Wait and try again.`);
  }
  if (res.status === 401) {
    throw new Error(
      `Chess.com explorer returned 401${suffix}. The session cookie is missing, expired, or incomplete.`,
    );
  }
  if (res.status === 400) {
    throw new Error(
      `Chess.com explorer returned 400${suffix}. Paste the Cookie header without wrapping quotes.`,
    );
  }
  throw new Error(`Failed to fetch Chess.com explorer: ${res.status} ${res.statusText}${suffix}`);
}

async function postExplore(body: unknown, sessionCookie: string): Promise<Response> {
  let last: Response | undefined;
  for (const url of CHESSCOM_EXPLORER_URLS) {
    const res = await fetch(url, {
      method: "POST",
      headers: explorerHeaders(sessionCookie),
      body: JSON.stringify(body),
    });
    if (res.ok || res.status === 401 || res.status === 429) {
      return res;
    }
    last = res;
    if (res.status !== 403 && res.status !== 404) {
      return res;
    }
  }
  return last!;
}

export function hasChessComSession(options: ChessComGamesOptions): boolean {
  return Boolean(options.sessionCookie?.trim());
}

export async function convertChessComSampleGames(
  games: z.infer<typeof chessComSampleGameSchema>[],
): Promise<NormalizedGame[]> {
  const limited = games.slice(0, 4);
  const results = await Promise.allSettled(
    limited.map(async (game, i) => {
      const pgn = await getChesscomGame(game.url);
      if (!pgn) {
        throw new Error(`Missing PGN for ${game.url}`);
      }
      const { headers, root } = await parsePGN(pgn);
      const normalized: NormalizedGame = {
        ...headers,
        id: i,
        white_id: 0,
        black_id: 0,
        event_id: 0,
        site_id: 0,
        moves: pgn,
        ply_count: countMainPly(root),
      };
      return normalized;
    }),
  );
  return results
    .filter((r) => r.status === "fulfilled")
    .map((r) => (r as PromiseFulfilledResult<NormalizedGame>).value);
}

export async function getChessComGames(
  fen: string,
  options: ChessComGamesOptions,
): Promise<{ openings: Opening[]; games: NormalizedGame[] }> {
  if (!hasChessComSession(options)) {
    throw new Error("Chess.com explorer requires a session cookie. Add one in the Options tab.");
  }

  const key = explorerCacheKey(fen, options);
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }

  const seq = ++requestSeq;
  const body = buildExploreRequest(fen, options);
  const res = await postExplore(body, options.sessionCookie ?? "");

  if (!res.ok) {
    await throwExplorerHttpError(res);
  }

  const json: unknown = await res.json();
  const parsed = parseExploreResponse(json);
  const openings = mapExploreToOpenings(parsed);
  const games = await convertChessComSampleGames([]);
  const result = { openings, games };

  cache.set(key, result);
  if (seq !== requestSeq) {
    return result;
  }
  return result;
}
