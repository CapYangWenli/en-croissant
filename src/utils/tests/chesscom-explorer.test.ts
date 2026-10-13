import { parseUci } from "chessops";
import { afterEach, expect, test } from "vitest";
import {
    buildExploreRequest,
    convertChessComSampleGames,
    DEFAULT_CHESSCOM_OPTIONS,
    explorerCacheKey,
    fenForChessComExplorer,
    CHESSCOM_EXPLORER_URLS,
    cookieHeader,
    getChessComGames,
    mapExploreToOpenings,
    parseExploreResponse,
    resetChessComExplorerCache,
} from "../chess.com/explorer";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const E4_FEN = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const E4_FIDE_FEN = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
const TRANSPOSED_FEN = "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1";
const E4_NC6_FEN = "r1bqkbnr/pppppppp/2n5/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 1 2";
const E4_NC6_D4_FEN = "r1bqkbnr/pppppppp/2n5/8/3PP3/8/PPP2PPP/RNBQKBNR b KQkq - 0 2";

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

test("keeps color WHITE after 1.e4 instead of using side-to-move", () => {
    const body = buildExploreRequest(E4_FEN, DEFAULT_CHESSCOM_OPTIONS, parseUci("e2e4"));
    expect(body.fen).toBe(E4_FIDE_FEN);
    expect(body.color).toBe(1);
});

test("restores FIDE en passant after double pawn pushes, not knight moves", () => {
    expect(fenForChessComExplorer(E4_FEN, parseUci("e2e4"))).toBe(E4_FIDE_FEN);
    expect(fenForChessComExplorer(E4_NC6_FEN, parseUci("b8c6"))).toBe(E4_NC6_FEN);
    expect(fenForChessComExplorer(E4_NC6_D4_FEN, parseUci("d2d4"))).toBe(
        "r1bqkbnr/pppppppp/2n5/8/3PP3/8/PPP2PPP/RNBQKBNR b KQkq d3 0 2",
    );
    expect(fenForChessComExplorer(E4_FEN, parseUci("e3e4"))).toBe(E4_FEN);
    expect(fenForChessComExplorer(START_FEN)).toBe(START_FEN);
});

test("strips wrapping quotes and Cookie: prefix from pasted headers", () => {
    expect(cookieHeader('"PHPSESSID=abc; ACCESS_TOKEN=tok"')).toBe(
        "PHPSESSID=abc; ACCESS_TOKEN=tok",
    );
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
    const e4 = explorerCacheKey(E4_FEN, options, parseUci("e2e4"));
    const sameFenDifferentCookie = explorerCacheKey(START_FEN, {
        ...options,
        sessionCookie: "other",
    });
    expect(start).not.toBe(e4);
    expect(start).toBe(sameFenDifferentCookie);
    expect(explorerCacheKey(TRANSPOSED_FEN, options, parseUci("d2d4"))).not.toBe(e4);
    expect(JSON.parse(e4).fen).toBe(E4_FIDE_FEN);
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
