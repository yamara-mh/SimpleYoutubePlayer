const creators = [
  {
    id: "youtube-developers",
    name: "YouTube Developers",
    playlists: [
      {
        id: "yt-dev-intro",
        title: "開発入門 Part 集",
        popularity: 980,
        videos: [
          { id: "M7lc1UVf-VE", title: "Part 3 はじめての設定", publishedAt: "2024-05-03T09:00:00Z" },
          { id: "XGSy3_Czz8k", title: "Part 2 やさしい操作", publishedAt: "2024-05-02T09:00:00Z" },
          { id: "ysz5S6PUM-U", title: "Part 1 まずは視聴", publishedAt: "2024-05-01T09:00:00Z" }
        ]
      },
      {
        id: "yt-dev-events",
        title: "公開イベントまとめ",
        popularity: 860,
        videos: [
          { id: "jNQXAC9IVRw", title: "春の配信ハイライト", publishedAt: "2024-06-20T09:00:00Z" },
          { id: "1La4QzGeaaQ", title: "夏の配信ハイライト", publishedAt: "2024-06-19T09:00:00Z" },
          { id: "LXb3EKWsInQ", title: "秋の配信ハイライト", publishedAt: "2024-06-18T09:00:00Z" }
        ]
      },
      {
        id: "yt-dev-campus",
        title: "学びなおしセレクション",
        popularity: 730,
        videos: [
          { id: "3fumBcKC6RE", title: "やさしい質問コーナー", publishedAt: "2024-02-10T09:00:00Z" },
          { id: "aqz-KE-bpKQ", title: "ゆっくり解説タイム", publishedAt: "2024-01-28T09:00:00Z" },
          { id: "9bZkp7q19f0", title: "復習ダイジェスト", publishedAt: "2024-01-03T09:00:00Z" }
        ]
      }
    ]
  },
  {
    id: "ed-sheeran",
    name: "Ed Sheeran",
    playlists: [
      {
        id: "ed-sheeran-diary",
        title: "Day ライブ日記",
        popularity: 920,
        videos: [
          { id: "2Vv-BfVoq4g", title: "Day 3 ライブの夜", publishedAt: "2023-09-03T09:00:00Z" },
          { id: "JGwWNGJdvx8", title: "Day 2 リハーサル", publishedAt: "2023-09-02T09:00:00Z" },
          { id: "lp-EO5I60KA", title: "Day 1 会場入り", publishedAt: "2023-09-01T09:00:00Z" }
        ]
      },
      {
        id: "ed-sheeran-picks",
        title: "人気ステージ集",
        popularity: 780,
        videos: [
          { id: "eVTXPUF4Oz4", title: "ステージ 1", publishedAt: "2024-03-10T09:00:00Z" },
          { id: "8sgycukafqQ", title: "ステージ 2", publishedAt: "2024-03-17T09:00:00Z" },
          { id: "kXYiU_JCYtU", title: "ステージ 3", publishedAt: "2024-03-24T09:00:00Z" }
        ]
      }
    ]
  },
  {
    id: "world-trips",
    name: "World Trips",
    playlists: [
      {
        id: "world-trips-seasons",
        title: "四季の旅",
        popularity: 810,
        videos: [
          { id: "dQw4w9WgXcQ", title: "第3話 秋の街歩き", publishedAt: "2022-11-03T09:00:00Z" },
          { id: "7QUtEmBT_-w", title: "第2話 夏の海辺", publishedAt: "2022-11-02T09:00:00Z" },
          { id: "fLexgOxsZu0", title: "第1話 春の公園", publishedAt: "2022-11-01T09:00:00Z" }
        ]
      },
      {
        id: "world-trips-weekend",
        title: "週末さんぽ",
        popularity: 650,
        videos: [
          { id: "60ItHLz5WEA", title: "朝の広場", publishedAt: "2024-04-13T09:00:00Z" },
          { id: "RgKAFK5djSk", title: "昼の市場", publishedAt: "2024-04-12T09:00:00Z" },
          { id: "ktvTqknDobU", title: "夜の灯り", publishedAt: "2024-04-11T09:00:00Z" }
        ]
      }
    ]
  }
];

const storageKey = "simple-youtube-player-state";
const previewDelayMs = 2000;
const defaultVolume = 5;

const creatorList = creators.map(normalizeCreator);
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
  likeToggle: document.getElementById("likeToggle"),
  moreButton: document.getElementById("moreButton"),
  nextButton: document.getElementById("nextButton"),
  assistMessage: document.getElementById("assistMessage")
};

const state = loadState();
const player = document.getElementById("player");
let playerLoaded = false;
let currentVideo = null;
let currentPlaylist = null;
let queuedPlayback = null;
let previewTimer = null;

wireEvents();
renderStaticState();
setupPlayer();

function normalizeCreator(creator) {
  return {
    ...creator,
    playlists: creator.playlists
      .slice()
      .sort((left, right) => right.popularity - left.popularity)
      .map((playlist) => normalizePlaylist(creator, playlist))
  };
}

function normalizePlaylist(creator, playlist) {
  const ordered = resolvePlaylistPlaybackOrder(playlist.videos);
  return {
    ...playlist,
    creatorId: creator.id,
    creatorName: creator.name,
    playbackMode: ordered.mode,
    orderedVideos: ordered.videos.map((video, index) => ({
      ...video,
      channel: creator.name,
      creatorId: creator.id,
      playlistId: playlist.id,
      playlistTitle: playlist.title,
      playbackIndex: index
    }))
  };
}

function resolvePlaylistPlaybackOrder(videos) {
  const orderedVideos = videos.slice();
  if (hasIntentionalPublishOrdering(orderedVideos)) {
    return { videos: orderedVideos, mode: "published-at" };
  }

  const numberedDirection = resolveNumberedDirection(orderedVideos);
  if (numberedDirection === "reverse") {
    return { videos: orderedVideos.reverse(), mode: "numbered" };
  }

  return { videos: orderedVideos, mode: numberedDirection === "keep" ? "numbered" : "default" };
}

function hasIntentionalPublishOrdering(videos) {
  return getDecisionSamples(videos).some((sample) => isMonotonic(sample, readPublishedAt));
}

function resolveNumberedDirection(videos) {
  for (const sample of getDecisionSamples(videos)) {
    const numbers = sample.map((video) => extractSequenceNumber(video.title));
    if (numbers.some((value) => value === null)) {
      continue;
    }

    const firstStep = numbers[1] - numbers[0];
    const secondStep = numbers[2] - numbers[1];
    if (Math.abs(firstStep) === 1 && firstStep === secondStep) {
      return firstStep > 0 ? "keep" : "reverse";
    }
  }

  return null;
}

function getDecisionSamples(videos) {
  if (videos.length < 3) {
    return [];
  }

  const samples = [videos.slice(0, 3)];
  const tailSample = videos.slice(-3);
  if (tailSample[0].id !== samples[0][0].id || tailSample[2].id !== samples[0][2].id) {
    samples.push(tailSample);
  }
  return samples;
}

function isMonotonic(videos, resolver) {
  const values = videos.map(resolver);
  if (values.some((value) => !Number.isFinite(value))) {
    return false;
  }

  const firstStep = values[1] - values[0];
  const secondStep = values[2] - values[1];
  return firstStep !== 0 && secondStep !== 0 && Math.sign(firstStep) === Math.sign(secondStep);
}

function readPublishedAt(video) {
  return Date.parse(video.publishedAt);
}

function extractSequenceNumber(title) {
  const normalized = normalizeDigits(title);
  const patterns = [
    /(?:#|＃)\s*(\d+)/i,
    /第\s*(\d+)\s*(?:話|回|章)/i,
    /\b(?:part|day|ep|episode)\s*(\d+)\b/i
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) {
      return Number.parseInt(match[1], 10);
    }
  }

  return null;
}

function normalizeDigits(text) {
  return text.replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 65248));
}

function setupPlayer() {
  player.addEventListener("load", function () {
    if (!player.src) {
      return;
    }
    player.contentWindow.postMessage(JSON.stringify({ event: "listening" }), "*");
  });

  window.addEventListener("message", onYouTubeMessage);

  const initialPlayback = resolveInitialPlayback();
  queuePlayback(initialPlayback, { assistText: "最初の再生リストを準備しています" });
}

function onYouTubeMessage(event) {
  if (event.origin !== "https://www.youtube.com") {
    return;
  }

  let data;
  try {
    data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
  } catch (error) {
    return;
  }

  if (data.event === "onReady") {
    playerLoaded = true;
    sendPlayerCommand("addEventListener", ["onStateChange"]);
    applyVolume();
    return;
  }

  if (data.event === "onStateChange") {
    handlePlayerStateChange(data.info);
  }
}

function handlePlayerStateChange(stateCode) {
  if (stateCode === 1) {
    state.isPlaying = true;
    elements.playToggle.innerHTML = "⏸️<br>停止";
    saveState();
    return;
  }

  if (stateCode === 2) {
    state.isPlaying = false;
    elements.playToggle.innerHTML = "▶️<br>再生";
    saveState();
    return;
  }

  if (stateCode === 0) {
    state.isPlaying = false;
    elements.playToggle.innerHTML = "▶️<br>再生";
    saveState();

    const nextPlayback = findNextSequentialPlayback(getCurrentPlayback());
    if (nextPlayback) {
      queuePlayback(nextPlayback, { assistText: "この再生リストの続きを準備しています" });
    } else {
      setAssistMessage("この投稿者の再生リストを見終わりました");
    }
  }
}

function sendPlayerCommand(func, args) {
  if (!playerLoaded) {
    return;
  }

  player.contentWindow.postMessage(
    JSON.stringify({ event: "command", func, args: args || [] }),
    "https://www.youtube.com"
  );
}

function loadYouTubeVideo(videoId) {
  playerLoaded = false;
  const params = new URLSearchParams({
    enablejsapi: 1,
    autoplay: 1,
    controls: 1,
    playsinline: 1,
    rel: 0,
    fs: 1
  });
  player.src = `https://www.youtube.com/embed/${videoId}?${params}`;
}

function wireEvents() {
  elements.playToggle.addEventListener("click", togglePlayback);
  elements.volumeDown.addEventListener("click", () => changeVolume(-1));
  elements.volumeUp.addEventListener("click", () => changeVolume(1));
  elements.likeToggle.addEventListener("click", toggleLike);
  elements.moreButton.addEventListener("click", playMoreVideos);
  elements.nextButton.addEventListener("click", playNextVideo);
}

function renderStaticState() {
  elements.volumeLevel.textContent = String(state.volume);
  elements.playToggle.innerHTML = state.isPlaying ? "⏸️<br>停止" : "▶️<br>再生";
  renderCurrentVideo();
}

function togglePlayback() {
  if (!currentVideo) {
    return;
  }

  if (state.isPlaying) {
    sendPlayerCommand("pauseVideo");
    setAssistMessage("動画を止めました");
    return;
  }

  sendPlayerCommand("playVideo");
  setAssistMessage("動画を再生しています");
}

function changeVolume(delta) {
  state.volume = clamp(state.volume + delta, 0, 9);
  applyVolume();
  renderStaticState();
  saveState();
  setAssistMessage(`音量を ${state.volume} にしました`);
}

function applyVolume() {
  elements.volumeLevel.textContent = String(state.volume);
  sendPlayerCommand("setVolume", [Math.round((state.volume / 9) * 100)]);
}

function toggleLike() {
  if (!currentVideo) {
    return;
  }

  const liked = new Set(state.likedVideoIds);
  if (liked.has(currentVideo.id)) {
    liked.delete(currentVideo.id);
    setAssistMessage("好みから外しました");
  } else {
    liked.add(currentVideo.id);
    setAssistMessage("この動画を好みに入れました");
  }

  state.likedVideoIds = Array.from(liked);
  renderCurrentVideo();
  saveState();
}

function playMoreVideos() {
  if (queuedPlayback) {
    const alternatePlayback = findAlternativePlaylistPlayback(queuedPlayback);
    if (!alternatePlayback) {
      setAssistMessage("ほかの再生リストがありません");
      return;
    }

    queuePlayback(alternatePlayback, { assistText: "別の再生リストを開いています" });
    return;
  }

  const nextPlayback = findNextSequentialPlayback(getCurrentPlayback());
  if (!nextPlayback) {
    setAssistMessage("この投稿者の続きがありません");
    return;
  }

  queuePlayback(nextPlayback, { assistText: "今の再生リストの続きを準備しています" });
}

function playNextVideo() {
  if (queuedPlayback) {
    startQueuedPlayback();
    setAssistMessage("すぐに再生します");
    return;
  }

  const nextCreatorPlayback = findNextCreatorPlayback(getCurrentPlayback());
  if (!nextCreatorPlayback) {
    setAssistMessage("次に見る投稿者がありません");
    return;
  }

  queuePlayback(nextCreatorPlayback, { assistText: "別の投稿者の動画を探しています" });
}

function queuePlayback(playback, options) {
  const video = getVideoForPlayback(playback);
  if (!video) {
    return;
  }

  clearPreviewTimer();
  queuedPlayback = playback;
  showPreview(video, options?.assistText || "まもなく再生します");
  previewTimer = window.setTimeout(startQueuedPlayback, previewDelayMs);
}

function startQueuedPlayback() {
  const playback = queuedPlayback;
  if (!playback) {
    return;
  }

  clearPreviewTimer();
  queuedPlayback = null;

  const playlist = playlistMap.get(playback.playlistId);
  const video = playlist?.orderedVideos[playback.videoIndex];
  if (!playlist || !video) {
    return;
  }

  currentPlaylist = playlist;
  currentVideo = video;
  state.currentCreatorId = playback.creatorId;
  state.currentPlaylistId = playlist.id;
  state.currentVideoId = video.id;
  saveState();

  hidePreview();
  renderCurrentVideo();
  loadYouTubeVideo(video.id);
  applyVolume();
  setAssistMessage(`${playlist.creatorName} の「${playlist.title}」を再生しています`);
}

function renderCurrentVideo() {
  const liked = currentVideo ? state.likedVideoIds.includes(currentVideo.id) : false;
  elements.likeToggle.innerHTML = liked ? "💖<br>取消" : "❤️<br>好み";
}

function setAssistMessage(text) {
  if (!elements.assistMessage) {
    return;
  }
  elements.assistMessage.textContent = text || "";
}

function showPreview(video, assistText) {
  elements.previewImage.src = thumbnailUrl(video.id);
  elements.previewTitle.textContent = video.title;
  elements.previewMeta.textContent = `${video.channel} ・ ${video.playlistTitle}`;
  elements.previewOverlay.classList.remove("hidden");
  setAssistMessage(assistText);
}

function hidePreview() {
  elements.previewOverlay.classList.add("hidden");
}

function resolveInitialPlayback() {
  const storedPlayback = findStoredPlayback();
  if (storedPlayback) {
    return storedPlayback;
  }

  const firstCreator = creatorList[0];
  const firstPlaylist = firstCreator?.playlists[0];
  return firstPlaylist
    ? { creatorId: firstCreator.id, playlistId: firstPlaylist.id, videoIndex: 0 }
    : null;
}

function findStoredPlayback() {
  if (state.currentPlaylistId && state.currentVideoId) {
    const playlist = playlistMap.get(state.currentPlaylistId);
    const videoIndex = playlist?.orderedVideos.findIndex((video) => video.id === state.currentVideoId);
    if (playlist && videoIndex >= 0) {
      return { creatorId: playlist.creatorId, playlistId: playlist.id, videoIndex };
    }
  }

  if (state.currentVideoId) {
    const video = videoMap.get(state.currentVideoId);
    if (video) {
      return { creatorId: video.creatorId, playlistId: video.playlistId, videoIndex: video.playbackIndex };
    }
  }

  if (state.currentCreatorId) {
    const creator = creatorMap.get(state.currentCreatorId);
    const playlist = creator?.playlists[0];
    if (playlist) {
      return { creatorId: creator.id, playlistId: playlist.id, videoIndex: 0 };
    }
  }

  return null;
}

function getCurrentPlayback() {
  if (!currentVideo || !currentPlaylist) {
    return null;
  }

  return {
    creatorId: currentPlaylist.creatorId,
    playlistId: currentPlaylist.id,
    videoIndex: currentVideo.playbackIndex
  };
}

function getVideoForPlayback(playback) {
  if (!playback) {
    return null;
  }

  const playlist = playlistMap.get(playback.playlistId);
  return playlist?.orderedVideos[playback.videoIndex] || null;
}

function findNextSequentialPlayback(playback) {
  if (!playback) {
    return null;
  }

  const playlist = playlistMap.get(playback.playlistId);
  if (!playlist) {
    return null;
  }

  if (playback.videoIndex + 1 < playlist.orderedVideos.length) {
    return {
      creatorId: playlist.creatorId,
      playlistId: playlist.id,
      videoIndex: playback.videoIndex + 1
    };
  }

  const creator = creatorMap.get(playlist.creatorId);
  const playlistIndex = creator?.playlists.findIndex((entry) => entry.id === playlist.id) ?? -1;
  const nextPlaylist = playlistIndex >= 0 ? creator.playlists[playlistIndex + 1] : null;
  if (!nextPlaylist) {
    return null;
  }

  return { creatorId: creator.id, playlistId: nextPlaylist.id, videoIndex: 0 };
}

function findAlternativePlaylistPlayback(playback) {
  if (!playback) {
    return null;
  }

  const creator = creatorMap.get(playback.creatorId);
  if (!creator || creator.playlists.length < 2) {
    return null;
  }

  const currentIndex = creator.playlists.findIndex((playlist) => playlist.id === playback.playlistId);
  for (let offset = 1; offset < creator.playlists.length; offset += 1) {
    const nextPlaylist = creator.playlists[(currentIndex + offset) % creator.playlists.length];
    if (nextPlaylist.id !== playback.playlistId) {
      return { creatorId: creator.id, playlistId: nextPlaylist.id, videoIndex: 0 };
    }
  }

  return null;
}

function findNextCreatorPlayback(playback) {
  if (!creatorList.length) {
    return null;
  }

  if (!playback) {
    const firstCreator = creatorList[0];
    return {
      creatorId: firstCreator.id,
      playlistId: firstCreator.playlists[0].id,
      videoIndex: 0
    };
  }

  const creatorIndex = creatorList.findIndex((creator) => creator.id === playback.creatorId);
  if (creatorIndex === -1) {
    return null;
  }

  const nextCreator = creatorList[(creatorIndex + 1) % creatorList.length];
  return {
    creatorId: nextCreator.id,
    playlistId: nextCreator.playlists[0].id,
    videoIndex: 0
  };
}

function clearPreviewTimer() {
  if (previewTimer !== null) {
    window.clearTimeout(previewTimer);
    previewTimer = null;
  }
}

function thumbnailUrl(videoId) {
  return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
}

function loadState() {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) {
      return createDefaultState();
    }

    return { ...createDefaultState(), ...JSON.parse(raw) };
  } catch (error) {
    return createDefaultState();
  }
}

function saveState() {
  window.localStorage.setItem(storageKey, JSON.stringify(state));
}

function createDefaultState() {
  return {
    currentCreatorId: "",
    currentPlaylistId: "",
    currentVideoId: "",
    isPlaying: false,
    likedVideoIds: [],
    volume: defaultVolume
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
