import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadBoardDefinition } from "../shared/circuit-board.mjs";
import { expandCompactBoard } from "../shared/board-format.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const gameRoot = path.resolve(__dirname, "..");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function selectMapEntry(manifest, {
  preferredMapId = null,
  randomFn = Math.random
} = {}) {
  const maps = Array.isArray(manifest?.maps) ? manifest.maps.filter((entry) => entry?.mapId && entry?.path) : [];

  if (maps.length === 0) {
    throw new Error("Map manifest must include at least one map entry.");
  }

  if (preferredMapId) {
    const preferredEntry = maps.find((entry) => entry.mapId === preferredMapId);
    if (preferredEntry) {
      return preferredEntry;
    }
  }

  if (manifest?.selectionMode === "default" && manifest?.defaultMapId) {
    const defaultEntry = maps.find((entry) => entry.mapId === manifest.defaultMapId);
    if (defaultEntry) {
      return defaultEntry;
    }
  }

  const rawIndex = Math.floor(Number(randomFn()) * maps.length);
  const safeIndex = Number.isFinite(rawIndex) && rawIndex >= 0 ? Math.min(rawIndex, maps.length - 1) : 0;
  return maps[safeIndex];
}

export function createBoardCatalog({
  gameDirectory = gameRoot,
  manifestRelativePath = path.join("maps", "index.json"),
  fallbackRelativePath = path.join("maps", "map-01.json"),
  randomFn = Math.random
} = {}) {
  const manifestPath = path.join(gameDirectory, manifestRelativePath);
  const manifest = readJson(manifestPath);
  const boardCache = new Map();

  function loadBoardFromRelativePath(relativePath) {
    if (!boardCache.has(relativePath)) {
      const absolutePath = path.join(gameDirectory, relativePath);
      const raw = readJson(absolutePath);
      const verbose = raw.grid ? expandCompactBoard(raw) : raw;
      boardCache.set(relativePath, loadBoardDefinition(verbose));
    }
    return boardCache.get(relativePath);
  }

  function loadBoardByMapId(mapId) {
    const mapEntry = selectMapEntry(manifest, {
      preferredMapId: mapId,
      randomFn: () => 0
    });

    if (!mapEntry || mapEntry.mapId !== mapId) {
      throw new Error(`Unknown map id: ${mapId}`);
    }

    return {
      manifest,
      mapEntry,
      board: loadBoardFromRelativePath(mapEntry.path)
    };
  }

  function selectBoard() {
    try {
      const mapEntry = selectMapEntry(manifest, { randomFn });
      return {
        manifest,
        mapEntry,
        board: loadBoardFromRelativePath(mapEntry.path)
      };
    } catch {
      const fallbackBoard = loadBoardFromRelativePath(fallbackRelativePath);
      return {
        manifest: null,
        mapEntry: {
          mapId: fallbackBoard.mapId || "fallback-map",
          title: fallbackBoard.title || "Fallback Map",
          path: fallbackRelativePath
        },
        board: fallbackBoard
      };
    }
  }

  return {
    manifest,
    loadBoardByMapId,
    selectBoard
  };
}
