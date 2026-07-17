const storageKey = "simple-youtube-player-state";
const categoryCatalogStorageKey = "simple-youtube-player-category-catalog";
const previewDelayMs = 2000;
const defaultVolume = 5;
const youtubeApiKey = ""; // YouTube Data API v3 key
const categorySearchRefreshMs = 6 * 60 * 60 * 1000;
const categorySearchShortenMs = 60 * 60 * 1000;
const categoryCatalogRefreshMs = 30 * 24 * 60 * 60 * 1000;
const dynamicSearchCreatorId = "__dynamic-search__";

const fallbackCategoryCatalog = [
  { id: "10", label: "音楽" },
  { id: "19", label: "旅行" },
  { id: "20", label: "ゲーム" },
  { id: "22", label: "ブログ" },
  { id: "23", label: "コメディ" },
  { id: "24", label: "エンタメ" },
  { id: "25", label: "ニュース" },
  { id: "26", label: "ハウツー" },
  { id: "27", label: "教育" },
  { id: "28", label: "科学" }
];
let categoryCatalog = fallbackCategoryCatalog.map((entry) => ({ ...entry }));

const creatorList = [];
const creatorMap = new Map(creatorList.map((creator) => [creator.id, creator]));
const playlistMap = new Map(
  creatorList.flatMap((creator) => creator.playlists.map((playlist) => [playlist.id, playlist]))
);
const videoMap = new Map(
  creatorList.flatMap((creator) =>
    creator.playlists.flatMap((playlist) => playlist.orderedVideos.map((video) => [video.id, video]))
  )
);

const elements = {
  previewOverlay: document.getElementById("previewOverlay"),
  previewImage: document.getElementById("previewImage"),
  previewTitle: document.getElementById("previewTitle"),
  previewMeta: document.getElementById("previewMeta"),
  playToggle: document.getElementById("playToggle"),
  volumeDown: document.getElementById("volumeDown"),
  volumeUp: document.getElementById("volumeUp"),
  volumeLevel: document.getElementById("volumeLevel"),
  moreButton: document.getElementById("moreButton"),
  searchButton: document.getElementById("nextButton")
};

function sanitizeNumericMap(value) {
  const result = {};
  if (!value || typeof value !== "object") {
    return result;
  }

  for (const [key, entryValue] of Object.entries(value)) {
    if (typeof key !== "string") {
      continue;
    }
    const numeric = Number(entryValue);
    if (Number.isFinite(numeric) && numeric > 0) {
      result[key] = numeric;
    }
  }

  return result;
}

function createDefaultState() {
  return {
    currentCreatorId: "",
    currentPlaylistId: "",
    currentVideoId: "",
    currentVideoCategoryId: "",
    currentVideoChannelId: "",
    isPlaying: false,
    volume: defaultVolume,
    interestTags: {},
    categoryInterests: {},
    lastInterestDecayDate: ""
  };
}

function loadState() {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) {
      return createDefaultState();
    }

    const parsed = JSON.parse(raw);
    const nextState = { ...createDefaultState(), ...parsed };

    if (!Array.isArray(nextState.likedVideoIds)) {
      delete nextState.likedVideoIds;
    }

    nextState.interestTags = sanitizeNumericMap(nextState.interestTags);
    nextState.categoryInterests = sanitizeNumericMap(nextState.categoryInterests);

    return nextState;
  } catch (_error) {
    return createDefaultState();
  }
}

function saveState() {
  window.localStorage.setItem(storageKey, JSON.stringify(state));
}

const state = loadState();
const player = document.getElementById("player");
let playerLoaded = false;
let currentVideo = null;
let currentPlaylist = null;
let queuedPlayback = null;
let previewTimer = null;
let isFetchingPlaylists = false;
let watchSessionStartedAt = 0;
let accumulatedWatchSeconds = 0;
let lastKnownDurationSeconds = 0;
let lastKnownCurrentSeconds = 0;
const creatorPageState = new Map();
const categorySearchCache = new Map();
const recentSelectedCategories = [];

