const videos = [
  { id: "M7lc1UVf-VE", title: "YouTube プレイヤーデモ", channel: "YouTube Developers", category: "学び" },
  { id: "dQw4w9WgXcQ", title: "Never Gonna Give You Up", channel: "Rick Astley", category: "音楽" },
  { id: "9bZkp7q19f0", title: "Gangnam Style", channel: "officialpsy", category: "音楽" },
  { id: "XGSy3_Czz8k", title: "やさしい紹介動画", channel: "YouTube Spotlight", category: "学び" },
  { id: "aqz-KE-bpKQ", title: "Sintel Trailer", channel: "Blender Foundation", category: "映画" },
  { id: "kXYiU_JCYtU", title: "Numb", channel: "Linkin Park", category: "音楽" },
  { id: "jNQXAC9IVRw", title: "Me at the zoo", channel: "jawed", category: "日常" },
  { id: "ysz5S6PUM-U", title: "おすすめプレイリスト", channel: "YouTube Viewers", category: "学び" },
  { id: "2Vv-BfVoq4g", title: "Perfect", channel: "Ed Sheeran", category: "音楽" },
  { id: "JGwWNGJdvx8", title: "Shape of You", channel: "Ed Sheeran", category: "音楽" },
  { id: "lp-EO5I60KA", title: "Thinking Out Loud", channel: "Ed Sheeran", category: "音楽" },
  { id: "LXb3EKWsInQ", title: "自然の風景", channel: "National Geographic", category: "自然" },
  { id: "eVTXPUF4Oz4", title: "In the End", channel: "Linkin Park", category: "音楽" },
  { id: "8sgycukafqQ", title: "What I've Done", channel: "Linkin Park", category: "音楽" },
  { id: "3fumBcKC6RE", title: "ゲーム実況ハイライト", channel: "Nintendo of America", category: "ゲーム" },
  { id: "1La4QzGeaaQ", title: "宇宙から見た地球", channel: "NASA", category: "ニュース" }
];

const videoMap = new Map(videos.map((video) => [video.id, video]));
const storageKey = "simple-youtube-player-state";
const previewDelayMs = 2000;
const comboWindowMs = 1000;
const defaultVolume = 5;

const elements = {
  previewOverlay: document.getElementById("previewOverlay"),
  previewImage: document.getElementById("previewImage"),
  previewTitle: document.getElementById("previewTitle"),
  previewMeta: document.getElementById("previewMeta"),
  playToggle: document.getElementById("playToggle"),
  volumeDown: document.getElementById("volumeDown"),
  volumeUp: document.getElementById("volumeUp"),
  volumeLevel: document.getElementById("volumeLevel"),
  prevButton: document.getElementById("prevButton"),
  nextButton: document.getElementById("nextButton")
};

const state = loadState();
const player = document.getElementById("player");
let playerLoaded = false;
let currentVideo = null;
let previewTimer = null;
let lastNavigation = { type: null, time: 0 };

wireEvents();
renderStaticState();
setupPlayer();

function setupPlayer() {
  player.addEventListener("load", function () {
    if (!player.src) {
      return;
    }
    player.contentWindow.postMessage(JSON.stringify({ event: "listening" }), "*");
  });

  window.addEventListener("message", onYouTubeMessage);

  const initialVideo = resolveInitialVideo();
  const knownIndex =
    state.historyIds[state.historyIndex] === initialVideo.id
      ? state.historyIndex
      : state.historyIds.indexOf(initialVideo.id);
  queueVideo(initialVideo, {
    recordHistory: knownIndex === -1,
    historyIndexOverride: knownIndex === -1 ? null : knownIndex,
    assistText: "最初の動画を準備しています"
  });
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
    elements.playToggle.textContent = "⏸️止める";
    saveState();
    return;
  }

  if (stateCode === 2 || stateCode === 0) {
    state.isPlaying = false;
    elements.playToggle.textContent = "▶️再生";
    saveState();
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
  elements.prevButton.addEventListener("click", playPreviousVideo);
  elements.nextButton.addEventListener("click", playNextVideo);
}

function renderStaticState() {
  elements.volumeLevel.textContent = String(state.volume);
  elements.playToggle.innerHTML = state.isPlaying ? "⏸️<br>停止" : "▶️<br>再生";
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

function playPreviousVideo() {
  if (state.historyIds.length <= 1) {
    setAssistMessage("まだ前の動画がありません");
    return;
  }

  const previousIndex = state.historyIndex - 1;
  if (previousIndex === -1) {
    setAssistMessage("これ以上戻れません");
    lastNavigation = { type: "prev", time: Date.now() };
    return;
  }

  lastNavigation = { type: "prev", time: Date.now() };
  const previousVideo = videoMap.get(state.historyIds[previousIndex]);
  queueVideo(previousVideo, {
    recordHistory: false,
    historyIndexOverride: previousIndex,
    assistText: "前に見た動画へ戻ります"
  });
}

function playNextVideo() {
  const forceDifferentGenre = isRecentNavigation("next");
  const nextVideo = pickNextVideo(forceDifferentGenre);
  lastNavigation = { type: "next", time: Date.now() };
  queueVideo(nextVideo, {
    recordHistory: true,
    historyIndexOverride: null,
    assistText: forceDifferentGenre ? "いつもと違うジャンルを探しています" : "見やすいおすすめ動画を選んでいます"
  });
}

function queueVideo(video, options) {
  if (!video) {
    return;
  }

  window.clearTimeout(previewTimer);
  showPreview(video, options.assistText);
  previewTimer = window.setTimeout(() => {
    startVideo(video, options);
  }, previewDelayMs);
}

function startVideo(video, options) {
  currentVideo = video;
  hidePreview();

  if (typeof options.historyIndexOverride === "number") {
    state.historyIndex = options.historyIndexOverride;
  } else if (options.recordHistory) {
    const nextHistory = state.historyIds.slice(0, state.historyIndex + 1);
    nextHistory.push(video.id);
    state.historyIds = nextHistory;
    state.historyIndex = state.historyIds.length - 1;
  }

  state.lastVideoId = video.id;
  state.lastWatchedAt[video.id] = Date.now();
  state.viewCounts[video.category] = (state.viewCounts[video.category] || 0) + 1;
  renderCurrentVideo();
  saveState();

  loadYouTubeVideo(video.id);
  applyVolume();
}

function renderCurrentVideo() {
  if (!currentVideo) {
    return;
  }
}

function setAssistMessage(_text) {}

function showPreview(video, assistText) {
  elements.previewImage.src = thumbnailUrl(video.id);
  elements.previewTitle.textContent = video.title;
  elements.previewMeta.textContent = `${video.channel} ・ ${video.category}`;
  elements.previewOverlay.classList.remove("hidden");
  setAssistMessage(assistText);
}

function hidePreview() {
  elements.previewOverlay.classList.add("hidden");
}

function resolveInitialVideo() {
  const knownVideo = videoMap.get(state.lastVideoId);
  if (knownVideo) {
    return knownVideo;
  }

  return videos[0];
}

function pickNextVideo(forceDifferentGenre) {
  const currentCategory = currentVideo ? currentVideo.category : null;
  const topCategory = getTopCategory();

  const scored = videos
    .filter((video) => !currentVideo || video.id !== currentVideo.id)
    .map((video) => ({
      video,
      score: scoreVideo(video, { currentCategory, topCategory, forceDifferentGenre })
    }))
    .sort((left, right) => right.score - left.score);

  return scored[0]?.video || videos[0];
}

function scoreVideo(video, context) {
  let score = 10;
  const categoryViews = state.viewCounts[video.category] || 0;
  const recentPenalty = state.lastWatchedAt[video.id] ? 6 : 0;

  score += categoryViews * 2;
  score -= recentPenalty;

  if (context.forceDifferentGenre) {
    if (video.category !== context.currentCategory && video.category !== context.topCategory) {
      score += 12;
    } else {
      score -= 12;
    }
  } else if (context.currentCategory && video.category === context.currentCategory) {
    score += 3;
  }

  return score + Math.random();
}

function isRecentNavigation(type) {
  return lastNavigation.type === type && Date.now() - lastNavigation.time <= comboWindowMs;
}

function getTopCategory() {
  const categories = Object.entries(state.viewCounts);
  categories.sort((left, right) => right[1] - left[1]);
  return categories[0]?.[0] || "";
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
    historyIds: [],
    historyIndex: -1,
    isPlaying: false,
    lastVideoId: "",
    lastWatchedAt: {},
    viewCounts: {},
    volume: defaultVolume
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
