const storageKey = "simple-youtube-player-state";
const previewDelayMs = 2000;
const comboWindowMs = 1000;
const defaultVolume = 5;
const youtubeRegionCode = "JP";
const youtubeMaxResults = 15;

// OAuth 2.0 implicit flow — client_id is a public identifier (not a secret).
// client_secret is intentionally absent; the implicit flow does not require it.
const oauthClientId = "431396271681-q2krn0mfqbp3i0nbhkamtb3sfvjqu93t.apps.googleusercontent.com";
const oauthRedirectUri = getOAuthRedirectUri();
const oauthScope = "https://www.googleapis.com/auth/youtube.readonly";
// sessionStorage keys — tab-scoped, cleared when the tab or browser is closed.
const oauthStateKey = "syp_oauth_state";
const oauthTokenKey = "syp_access_token";
const oauthTokenExpiryKey = "syp_token_expiry";

let videos = [];
let videoMap = new Map();

const elements = {
  previewOverlay: document.getElementById("previewOverlay"),
  previewImage: document.getElementById("previewImage"),
  previewTitle: document.getElementById("previewTitle"),
  previewMeta: document.getElementById("previewMeta"),
  authOverlay: document.getElementById("authOverlay"),
  authButton: document.getElementById("authButton"),
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
bootstrap();

async function bootstrap() {
  // Process an OAuth callback if the URL fragment contains an access token.
  handleOAuthCallback();

  const accessToken = getStoredToken();
  if (!accessToken) {
    showAuthPrompt();
    return;
  }

  try {
    await loadMostPopularVideos(accessToken);
    setupPlayer();
  } catch (error) {
    console.error(error);
    if (error.status === 401 || error.status === 403) {
      // Token is invalid or revoked — clear it and re-authenticate.
      clearStoredToken();
      showAuthPrompt();
    } else {
      showLoadError("人気動画の読み込みに失敗しました");
    }
  }
}

async function loadMostPopularVideos(accessToken) {
  const params = new URLSearchParams({
    part: "snippet",
    chart: "mostPopular",
    maxResults: String(youtubeMaxResults),
    regionCode: youtubeRegionCode
  });

  const response = await fetch(`https://www.googleapis.com/youtube/v3/videos?${params}`, {
    headers: { Authorization: "Bearer " + accessToken }
  });

  if (!response.ok) {
    const err = new Error(`YouTube API request failed: ${response.status}`);
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  videos = (data.items || [])
    .map((item) => mapVideoItem(item))
    .filter(Boolean);
  videoMap = new Map(videos.map((video) => [video.id, video]));

  if (!videos.length) {
    throw new Error("YouTube API returned no videos");
  }

  hideAuthPrompt();
}

function mapVideoItem(item) {
  const id = item?.id;
  const snippet = item?.snippet;

  if (!id || !snippet?.title) {
    return null;
  }

  return {
    id,
    title: snippet.title,
    channel: snippet.channelTitle || "YouTube",
    category: snippet.categoryId || "unknown"
  };
}

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
  elements.authButton.addEventListener("click", initiateOAuth);
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

function showAuthPrompt() {
  elements.authOverlay.classList.remove("hidden");
}

function hideAuthPrompt() {
  elements.authOverlay.classList.add("hidden");
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
  elements.previewMeta.textContent = video.channel;
  elements.previewOverlay.classList.remove("hidden");
  setAssistMessage(assistText);
}

function showLoadError(message) {
  elements.previewImage.removeAttribute("src");
  elements.previewTitle.textContent = message;
  elements.previewMeta.textContent = "しばらく経ってからページを再読み込みしてください";
  elements.previewOverlay.classList.remove("hidden");
}

function hidePreview() {
  elements.previewOverlay.classList.add("hidden");
}

function resolveInitialVideo() {
  if (!videos.length) {
    return null;
  }

  const knownVideo = videoMap.get(state.lastVideoId);
  if (knownVideo) {
    return knownVideo;
  }

  return videos[0];
}

function pickNextVideo(forceDifferentGenre) {
  if (!videos.length) {
    return null;
  }

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

// ---------------------------------------------------------------------------
// OAuth 2.0 — implicit flow (no backend required, no client_secret needed)
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically random hex string to use as the OAuth state
 * parameter. This prevents CSRF attacks by verifying the round-trip value.
 */
function generateOAuthState() {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Redirect the browser to the Google OAuth 2.0 consent/authorisation page.
 * A fresh state value is written to sessionStorage before the redirect so it
 * can be verified when Google calls back.
 */
function initiateOAuth() {
  const state = generateOAuthState();
  sessionStorage.setItem(oauthStateKey, state);

  const params = new URLSearchParams({
    client_id: oauthClientId,
    redirect_uri: oauthRedirectUri,
    response_type: "token",
    scope: oauthScope,
    state: state,
    include_granted_scopes: "true"
  });

  window.location.href = "https://accounts.google.com/o/oauth2/v2/auth?" + params;
}

function getOAuthRedirectUri() {
  if (location.hostname === "yamara-mh.github.io") {
    return "https://yamara-mh.github.io/SimpleYoutubePlayer/";
  }

  const pathname = location.pathname.replace(/index\.html$/i, "");
  return `${location.origin}${pathname.endsWith("/") ? pathname : `${pathname}/`}`;
}

/**
 * Inspect the URL fragment for an OAuth callback, validate it, and store the
 * access token in sessionStorage. The fragment is immediately removed from the
 * URL so the token is never recorded in browser history or sent as a Referer.
 *
 * Returns true if a valid token was found and stored, false otherwise.
 */
function handleOAuthCallback() {
  const fragment = window.location.hash.slice(1);
  if (!fragment) {
    return false;
  }

  const params = new URLSearchParams(fragment);

  // Strip the fragment from the URL immediately regardless of outcome.
  history.replaceState(null, "", window.location.pathname + window.location.search);

  const error = params.get("error");
  if (error) {
    console.error("OAuth error:", error);
    return false;
  }

  const token = params.get("access_token");
  const state = params.get("state");
  const expiresIn = Number(params.get("expires_in") || 0);

  if (!token || !state) {
    return false;
  }

  // Validate state to guard against CSRF.
  const expectedState = sessionStorage.getItem(oauthStateKey);
  sessionStorage.removeItem(oauthStateKey);

  if (!expectedState || state !== expectedState) {
    console.error("OAuth state mismatch — possible CSRF attack, ignoring token");
    return false;
  }

  storeToken(token, expiresIn);
  return true;
}

/**
 * Return the stored access token if one exists and has not expired, or null.
 */
function getStoredToken() {
  const token = sessionStorage.getItem(oauthTokenKey);
  const expiry = Number(sessionStorage.getItem(oauthTokenExpiryKey) || 0);
  if (token && Date.now() < expiry) {
    return token;
  }
  clearStoredToken();
  return null;
}

/**
 * Persist the access token and its expiry time in sessionStorage.
 * A 60-second safety margin is applied so tokens are not used right at the
 * edge of their validity window.
 */
function storeToken(token, expiresIn) {
  const expiry = Date.now() + Math.max(0, expiresIn - 60) * 1000;
  sessionStorage.setItem(oauthTokenKey, token);
  sessionStorage.setItem(oauthTokenExpiryKey, String(expiry));
}

/** Remove any stored token and its expiry from sessionStorage. */
function clearStoredToken() {
  sessionStorage.removeItem(oauthTokenKey);
  sessionStorage.removeItem(oauthTokenExpiryKey);
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
