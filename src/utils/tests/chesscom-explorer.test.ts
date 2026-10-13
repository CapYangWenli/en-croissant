import { afterEach, expect, test } from "vitest";
import {
  buildExploreRequest,
  convertChessComSampleGames,
  DEFAULT_CHESSCOM_OPTIONS,
  explorerCacheKey,
  CHESSCOM_EXPLORER_URLS,
  cookieHeader,
  getChessComGames,
  mapExploreToOpenings,
  parseExploreResponse,
  resetChessComExplorerCache,
} from "../chess.com/explorer";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const E4_FEN = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const TRANSPOSED_FEN = "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1";

afterEach(() => {
  resetChessComExplorerCache();
});

test("builds a FEN request with rating, time class, and date filters", () => {
  const body = buildExploreRequest(START_FEN, {
    timeClasses: ["blitz", "rapid"],
    minRating: 1400,
    maxRating: 1800,
    since: new Date(2024, 0, 1),
    until: new Date(2024, 11, 1),
    sessionCookie: "secret",
  });

  expect(body.fen).toBe(START_FEN);
  expect(body.color).toBe(1);
  expect(body.timeClasses).toEqual([3, 4]);
  expect(body.includeEvals).toBe(false);
  expect(body.ratingBand).toEqual({ minRating: 1400, maxRating: 1800 });
  expect(body.dateBand).toEqual({
    startDate: { year: 2024, month: 1, day: 1 },
    endDate: { year: 2024, month: 12, day: 1 },
  });
  expect(body).not.toHaveProperty("sessionCookie");
});

test("omits unbounded rating max of 4000 and empty date band", () => {
  const body = buildExploreRequest(START_FEN, {
    timeClasses: ["bullet"],
    minRating: 2000,
    maxRating: 4000,
  });
  expect(body.ratingBand).toEqual({ minRating: 2000 });
  expect(body.dateBand).toBeUndefined();
  expect(body.timeClasses).toEqual([2]);
});

test("derives BLACK from a black-to-move FEN", () => {
  expect(buildExploreRequest(E4_FEN, DEFAULT_CHESSCOM_OPTIONS).color).toBe(2);
});

test("strips wrapping quotes and Cookie: prefix from pasted headers", () => {
  expect(cookieHeader('"PHPSESSID=abc; ACCESS_TOKEN=tok"')).toBe("PHPSESSID=abc; ACCESS_TOKEN=tok");
  expect(cookieHeader("Cookie: PHPSESSID=abc")).toBe("PHPSESSID=abc");
  expect(cookieHeader("  abc123  ")).toBe("PHPSESSID=abc123");
});

test("maps proto-json move stats including int64 strings", () => {
  const parsed = parseExploreResponse({
    perMoveResponse: [
      {
        moveSan: "d4",
        numGamesPlayed: "100",
        numWhiteWins: "40",
        numBlackWins: "35",
        numDraws: "25",
      },
      {
        moveSan: "e4",
        numGamesPlayed: 200,
        numWhiteWins: 90,
        numBlackWins: 70,
        numDraws: 40,
      },
    ],
  });
  const openings = mapExploreToOpenings(parsed);
  expect(openings[0]).toEqual({ move: "e4", white: 90, black: 70, draw: 40 });
  expect(openings[1]).toEqual({ move: "d4", white: 40, black: 35, draw: 25 });
});

test("empty explorer stats are an empty list, not an error", () => {
  const openings = mapExploreToOpenings(parseExploreResponse({ perMoveResponse: [] }));
  expect(openings).toEqual([]);
});

test("cache key uses FEN so transpositions are distinct only when FEN differs", () => {
  const options = DEFAULT_CHESSCOM_OPTIONS;
  const start = explorerCacheKey(START_FEN, options);
  const e4 = explorerCacheKey(E4_FEN, options);
  const sameFenDifferentCookie = explorerCacheKey(START_FEN, {
    ...options,
    sessionCookie: "other",
  });
  expect(start).not.toBe(e4);
  expect(start).toBe(sameFenDifferentCookie);
  expect(explorerCacheKey(TRANSPOSED_FEN, options)).not.toBe(e4);
});

test("sample game converter returns nothing when Chess.com sends no games", async () => {
  expect(await convertChessComSampleGames([])).toEqual([]);
});

test("posts to Chess.com Connect-RPC hosts, not the public suggested-moves callback", () => {
  expect(CHESSCOM_EXPLORER_URLS[0]).toContain(
    "www.chess.com/service/all-games-explorer/chesscom.all_games_explorer.v1.AllGamesExplorerService/Explore",
  );
  expect(CHESSCOM_EXPLORER_URLS[1]).toContain(
    "prod.chess-platform.com/service/all-games-explorer/chesscom.all_games_explorer.v1.AllGamesExplorerService/Explore",
  );
});

test("refuses to call Chess.com without a session cookie", async () => {
  await expect(getChessComGames(START_FEN, DEFAULT_CHESSCOM_OPTIONS)).rejects.toThrow(
    /session cookie/i,
  );
});
