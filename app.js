const storageKey = "simple-youtube-player-state";
const previewDelayMs = 2000;
const previewDelayWhileShowingMs = 4000;
const previewDelayBefore15SecondsMs = 3000;
const defaultVolume = 5;
const youtubeRegionCode = "JP";
const youtubeMaxResults = 15;
const discoveryMaxResults = 50;
const discoveryCacheLimit = 100;
const discoveryTagLimit = 64;
const tagInterestLimit = 512;
const discoveryRefreshMs = 6 * 60 * 60 * 1000;
const playbackPollMs = 1000;
const minimumTrackedPlaybackSeconds = 15;
const shortVideoSeconds = 30;
const initialInterestTags = [
  "生活", "便利", "新商品", "お得", "雑談", "旅行", "海外", "キャンプ", "ドライブ", "風景",
  "健康", "シニア", "ストレッチ", "ヨガ", "筋トレ", "美容", "ファッション", "趣味", "料理", "簡単レシピ", "グルメ", "ペット", "パチンコ", "終活",
  "ニュース", "スポーツ", "自己啓発", "解説", "技術", "哲学", "心理学", "投資", "歴史", "語学", "美術", "宇宙", "プログラミング",
  "音楽", "J-POP", "洋楽", "K-POP", "Hip Hop", "クラシック", "ヒット曲", "名曲", "演奏", "作業用BGM", "パフォーマンス",
  "エンターテインメント", "お笑い", "バラエティ", "落語", "ゲーム", "漫画", "アニメ", "ドラマ", "映画", "考察", "感動", "ドキュメンタリー", "ミステリー", "謎解き"
];
const recentSearchTagLimit = 6;

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
let accessToken = "";
let queuedVideo = null;
let channelPlaylists = null;

const elements = {
  previewOverlay: document.getElementById("previewOverlay"),
  previewImage: document.getElementById("previewImage"),
  previewTitle: document.getElementById("previewTitle"),
  previewMeta: document.getElementById("previewMeta"),
  authOverlay: document.getElementById("authOverlay"),
  authButton: document.getElementById("authButton"),
  interestSetupOverlay: document.getElementById("interestSetupOverlay"),
  interestTagList: document.getElementById("interestTagList"),
  interestSetupButton: document.getElementById("interestSetupButton"),
  playToggle: document.getElementById("playToggle"),
  volumeDown: document.getElementById("volumeDown"),
  volumeUp: document.getElementById("volumeUp"),
  volumeLevel: document.getElementById("volumeLevel"),
  moreButton: document.getElementById("moreButton"),
  discoverButton: document.getElementById("discoverButton")
};

const state = loadState();
const player = document.getElementById("player");
let playerLoaded = false;
let currentVideo = null;
let previewTimer = null;
let playback = createPlaybackState();
let playbackPollTimer = null;
let discoveryButtonsBusy = false;

wireEvents();
renderStaticState();
renderInterestSetup();
bootstrap();

async function bootstrap() {
  // Process an OAuth callback if the URL fragment contains an access token.
  handleOAuthCallback();

  accessToken = getStoredToken();
  if (!accessToken) {
    hideInterestSetup();
    showAuthPrompt();
    return;
  }

  if (!state.initialSetupCompleted) {
    showInterestSetup();
    return;
  }

  hideInterestSetup();
  try {
    console.info("[tagInterests] Loaded", state.tagInterests);
    decayTagInterestsForNewDay();
    await loadMostPopularVideos();
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

async function loadMostPopularVideos() {
  const params = new URLSearchParams({
    part: "snippet,contentDetails",
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
    channelId: snippet.channelId || "",
    category: snippet.categoryId || "unknown",
    tags: Array.isArray(snippet.tags) ? snippet.tags : [],
    duration: parseYouTubeDuration(item.contentDetails?.duration)
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
    window.clearInterval(playbackPollTimer);
    playbackPollTimer = window.setInterval(requestPlaybackInfo, playbackPollMs);
    requestPlaybackInfo();
    applyVolume();
    return;
  }

  if (data.event === "onStateChange") {
    handlePlayerStateChange(data.info);
  }

  if (data.event === "infoDelivery") {
    updatePlaybackInfo(data.info || {});
  }
}

function handlePlayerStateChange(stateCode) {
  if (stateCode === 1) {
    state.isPlaying = true;
    elements.playToggle.innerHTML = "⏸️<br>止める";
    saveState();
    return;
  }

  if (stateCode === 2 || stateCode === 0) {
    state.isPlaying = false;
    elements.playToggle.innerHTML = "▶️<br>再生";
    saveState();
    if (stateCode === 0) {
      finalizeCurrentVideo();
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
  elements.authButton.addEventListener("click", initiateOAuth);
  elements.interestSetupButton.addEventListener("click", completeInterestSetup);
  elements.interestTagList.addEventListener("change", updateInterestSetupButton);
  elements.playToggle.addEventListener("click", togglePlayback);
  elements.volumeDown.addEventListener("click", () => changeVolume(-1));
  elements.volumeUp.addEventListener("click", () => changeVolume(1));
  elements.moreButton.addEventListener("click", playMoreVideos);
  elements.discoverButton.addEventListener("click", discoverVideo);
  window.addEventListener("beforeunload", finalizeCurrentVideo);
}

function renderInterestSetup() {
  elements.interestTagList.replaceChildren(
    ...initialInterestTags.map((tag, index) => {
      const wrapper = document.createElement("div");
      wrapper.className = "interest-tag";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.id = `interest-tag-${index}`;
      input.value = tag;
      const label = document.createElement("label");
      label.htmlFor = input.id;
      label.textContent = tag;
      wrapper.append(input, label);
      return wrapper;
    })
  );
  updateInterestSetupButton();
}

function updateInterestSetupButton() {
  elements.interestSetupButton.disabled =
    elements.interestTagList.querySelectorAll("input:checked").length === 0;
}

function showInterestSetup() {
  elements.interestSetupOverlay.classList.remove("hidden");
  elements.interestSetupButton.disabled = true;
}

function hideInterestSetup() {
  elements.interestSetupOverlay.classList.add("hidden");
}

function completeInterestSetup() {
  const selectedTags = [...elements.interestTagList.querySelectorAll("input:checked")]
    .map((input) => input.value);
  if (!selectedTags.length) {
    return;
  }

  state.tagInterests = Object.fromEntries(selectedTags.map((tag) => [tag, 1]));
  state.initialSetupCompleted = true;
  saveState();
  elements.interestSetupOverlay.classList.add("hidden");
  bootstrap();
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

function setDiscoveryButtonsBusy(isBusy) {
  discoveryButtonsBusy = isBusy;
  for (const button of [elements.moreButton, elements.discoverButton]) {
    button.disabled = isBusy;
    button.setAttribute("aria-busy", String(isBusy));
  }
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

async function playMoreVideos() {
  const sourceVideo = queuedVideo || currentVideo;
  const switchingPreview = isThumbnailVisible();
  if (!sourceVideo?.channelId) {
    return;
  }

  setDiscoveryButtonsBusy(true);
  try {
    const actionPreviewDelayMs = getPreviewDelayForAction();
    finalizeCurrentVideo();
    await ensureChannelPlaylists(sourceVideo.channelId);
    const playlist =
      switchingPreview
        ? await findAnotherPlaylist(sourceVideo.playlistId)
        : await findNextPlaylistVideo(sourceVideo.playlistId);

    if (!playlist) {
      setAssistMessage("再生できる動画がありません");
      return;
    }

    queueVideo(playlist.video, {
      recordHistory: true,
      historyIndexOverride: null,
      previewDelayMs: actionPreviewDelayMs,
      assistText: playlist.isDifferent
        ? "別の再生リストを準備しています"
        : "次の動画を準備しています"
    });
  } catch (error) {
    console.error(error);
    setAssistMessage("再生リストの読み込みに失敗しました");
  } finally {
    setDiscoveryButtonsBusy(false);
  }
}

async function ensureChannelPlaylists(channelId) {
  if (channelPlaylists?.channelId === channelId) {
    return;
  }

  const channel = await fetchYouTube("channels", {
    part: "contentDetails",
    id: channelId
  });
  const uploadsPlaylistId = channel.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  channelPlaylists = {
    channelId,
    groups: [],
    nextPageToken: "",
    allPublicPlaylistsLoaded: false,
    uploadsPlaylistId: uploadsPlaylistId || "",
    uploadsGroup: null,
    playlistCursor: 0
  };
  await loadMorePublicPlaylists();
}

async function loadMorePublicPlaylists() {
  if (!channelPlaylists || channelPlaylists.allPublicPlaylistsLoaded) {
    return;
  }

  const data = await fetchYouTube("playlists", {
    part: "snippet",
    channelId: channelPlaylists.channelId,
    maxResults: String(youtubeMaxResults),
    ...(channelPlaylists.nextPageToken && { pageToken: channelPlaylists.nextPageToken })
  });
  const knownIds = new Set(channelPlaylists.groups.map((group) => group.id));
  for (const item of data.items || []) {
    if (item.id && !knownIds.has(item.id)) {
      channelPlaylists.groups.push(createPlaylistGroup(item.id, item.snippet?.title || "再生リスト"));
    }
  }
  channelPlaylists.nextPageToken = data.nextPageToken || "";
  channelPlaylists.allPublicPlaylistsLoaded = !channelPlaylists.nextPageToken;
}

function createPlaylistGroup(id, title) {
  return { id, title, videos: [], nextPageToken: "", loaded: false, exhausted: false, cursor: 0 };
}

async function findNextPlaylistVideo(playlistId) {
  const currentGroup = findPlaylistGroup(playlistId);
  if (currentGroup) {
    const video = await takePlaylistVideo(currentGroup);
    if (video) {
      return { video, isDifferent: false };
    }
  }
  return findAnotherPlaylist(playlistId);
}

async function findAnotherPlaylist(excludedPlaylistId) {
  while (true) {
    const group = await findNextAvailablePublicPlaylist(excludedPlaylistId);
    if (group) {
      const video = await takePlaylistVideo(group);
      if (video) {
        return { video, isDifferent: true };
      }
      continue;
    }

    if (!channelPlaylists.allPublicPlaylistsLoaded) {
      await loadMorePublicPlaylists();
      continue;
    }

    const uploads = await getUploadsPlaylist();
    if (uploads) {
      const video = await takePlaylistVideo(uploads);
      if (video) {
        return { video, isDifferent: true };
      }
    }

    resetPublicPlaylistTraversal();
    const restartedGroup = await findNextAvailablePublicPlaylist("");
    if (restartedGroup) {
      const video = await takePlaylistVideo(restartedGroup);
      if (video) {
        return { video, isDifferent: true };
      }
    }
    if (channelPlaylists.uploadsGroup?.videos.length) {
      channelPlaylists.uploadsGroup.cursor = 0;
      const video = await takePlaylistVideo(channelPlaylists.uploadsGroup);
      if (video) {
        return { video, isDifferent: true };
      }
    }
    return null;
  }
}

async function findNextAvailablePublicPlaylist(excludedPlaylistId) {
  const groups = channelPlaylists.groups;
  for (let offset = 0; offset < groups.length; offset += 1) {
    const index = (channelPlaylists.playlistCursor + offset) % groups.length;
    const group = groups[index];
    if (
      group.id !== excludedPlaylistId &&
      (group.cursor < group.videos.length || !group.exhausted)
    ) {
      channelPlaylists.playlistCursor = (index + 1) % groups.length;
      return group;
    }
  }
  return null;
}

function findPlaylistGroup(playlistId) {
  if (!playlistId || !channelPlaylists) {
    return null;
  }
  if (channelPlaylists.uploadsGroup?.id === playlistId) {
    return channelPlaylists.uploadsGroup;
  }
  return channelPlaylists.groups.find((group) => group.id === playlistId) || null;
}

async function getUploadsPlaylist() {
  if (!channelPlaylists.uploadsPlaylistId) {
    return null;
  }
  if (!channelPlaylists.uploadsGroup) {
    channelPlaylists.uploadsGroup = createPlaylistGroup(
      channelPlaylists.uploadsPlaylistId,
      "すべての動画"
    );
  }
  return channelPlaylists.uploadsGroup.exhausted ? null : channelPlaylists.uploadsGroup;
}

async function takePlaylistVideo(group) {
  while (group.cursor >= group.videos.length && !group.exhausted) {
    await loadPlaylistVideos(group);
  }
  return group.videos[group.cursor++] || null;
}

async function loadPlaylistVideos(group) {
  const data = await fetchYouTube("playlistItems", {
    part: "snippet,contentDetails",
    playlistId: group.id,
    maxResults: String(youtubeMaxResults),
    ...(group.nextPageToken && { pageToken: group.nextPageToken })
  });
  group.videos.push(
    ...(data.items || []).map((item) => mapPlaylistItem(item, group)).filter(Boolean)
  );
  group.nextPageToken = data.nextPageToken || "";
  group.loaded = true;
  group.exhausted = !group.nextPageToken;
}

function mapPlaylistItem(item, group) {
  const id = item?.contentDetails?.videoId;
  const snippet = item?.snippet;
  if (!id || !snippet?.title || snippet.title === "Deleted video" || snippet.title === "Private video") {
    return null;
  }
  const video = {
    id,
    title: snippet.title,
    channel: snippet.videoOwnerChannelTitle || snippet.channelTitle || "YouTube",
    channelId: snippet.videoOwnerChannelId || snippet.channelId || channelPlaylists.channelId,
    category: "playlist",
    playlistId: group.id
  };
  videoMap.set(id, video);
  return video;
}

function resetPublicPlaylistTraversal() {
  for (const group of channelPlaylists.groups) {
    group.cursor = 0;
  }
  channelPlaylists.playlistCursor = 0;
}

async function fetchYouTube(resource, params) {
  const response = await fetch(
    `https://www.googleapis.com/youtube/v3/${resource}?${new URLSearchParams(params)}`,
    { headers: { Authorization: "Bearer " + accessToken } }
  );
  if (!response.ok) {
    const error = new Error(`YouTube API request failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function discoverVideo() {
  if (discoveryButtonsBusy) {
    return;
  }

  const switchingPreview = isThumbnailVisible();
  const sourceVideo = queuedVideo || currentVideo;

  if (switchingPreview) {
    setDiscoveryButtonsBusy(true);
    try {
      window.clearTimeout(previewTimer);
      finalizeCurrentVideo();
      const tag = selectDiscoveryTag();
      await queueDiscoveryVideo(tag, true, "別の動画を探しています", previewDelayWhileShowingMs);
    } finally {
      setDiscoveryButtonsBusy(false);
    }
    return;
  }

  if (sourceVideo && currentVideo === sourceVideo && watchedAtLeastHalf()) {
    await playMoreVideos();
    return;
  }

  setDiscoveryButtonsBusy(true);
  finalizeCurrentVideo();
  const tag = sourceVideo?.discoveryTag || selectDiscoveryTag();
  try {
    await queueDiscoveryVideo(
      tag,
      false,
      "おすすめ動画を探しています",
      getPreviewDelayForAction()
    );
  } finally {
    setDiscoveryButtonsBusy(false);
  }
}

function queueVideo(video, options) {
  if (!video) {
    return;
  }

  window.clearTimeout(previewTimer);
  queuedVideo = video;
  showPreview(video, options.assistText);
  previewTimer = window.setTimeout(() => {
    startVideo(video, options);
  }, options.previewDelayMs ?? previewDelayMs);
}

function startVideo(video, options) {
  queuedVideo = null;
  currentVideo = video;
  playback = createPlaybackState(video);
  loadVideoMetadata(video);
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

function isThumbnailVisible() {
  return Boolean(queuedVideo && !elements.previewOverlay.classList.contains("hidden"));
}

function getPreviewDelayForAction() {
  if (isThumbnailVisible()) {
    return previewDelayWhileShowingMs;
  }
  return playback.totalSeconds <= minimumTrackedPlaybackSeconds
    ? previewDelayBefore15SecondsMs
    : previewDelayMs;
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

function thumbnailUrl(videoId) {
  return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
}

async function queueDiscoveryVideo(tag, forceRefresh, assistText, actionPreviewDelayMs = previewDelayMs) {
  if (!tag) {
    setAssistMessage("おすすめ動画を選べませんでした");
    return;
  }

  try {
    const group = await getTagVideoList(tag, forceRefresh);
    const video = group.videos.find((item) => item.id !== currentVideo?.id);
    if (!video) {
      setAssistMessage("再生できる動画がありません");
      return;
    }
    queueVideo(video, {
      recordHistory: true,
      historyIndexOverride: null,
      previewDelayMs: actionPreviewDelayMs,
      assistText
    });
  } catch (error) {
    console.error(error);
    setAssistMessage("動画の検索に失敗しました");
  }
}

async function getTagVideoList(tag, forceRefresh) {
  const group = state.tagVideoLists[tag];
  if (!forceRefresh && group?.refreshAt > Date.now() && Array.isArray(group.videos)) {
    console.info("[tagInterests] Using cached videos", { tag, interests: state.tagInterests });
    return group;
  }

  console.info("[tagInterests] Fetching videos", { tag, interests: state.tagInterests });
  const search = await fetchYouTube("search", {
    part: "snippet",
    q: tag,
    type: "video",
    maxResults: String(discoveryMaxResults),
    regionCode: youtubeRegionCode
  });
  const ids = (search.items || []).map((item) => item.id?.videoId).filter(Boolean);
  const details = ids.length
    ? await fetchYouTube("videos", { part: "snippet,contentDetails", id: ids.join(",") })
    : { items: [] };
  const detailById = new Map((details.items || []).map((item) => [item.id, item]));
  const added = ids
    .map((id) => mapVideoItem(detailById.get(id)))
    .filter(Boolean)
    .map((video) => ({ ...video, tags: video.tags.length ? video.tags : [tag], discoveryTag: tag }));
  const addedIds = new Set(added.map((video) => video.id));
  const videosForTag = [
    ...added,
    ...(Array.isArray(group?.videos) ? group.videos.filter((video) => !addedIds.has(video.id)) : [])
  ].slice(0, discoveryCacheLimit);

  for (const video of videosForTag) {
    videoMap.set(video.id, video);
  }
  state.tagVideoLists[tag] = { videos: videosForTag, refreshAt: Date.now() + discoveryRefreshMs };
  state.recentSearchTags = [tag, ...state.recentSearchTags.filter((item) => item !== tag)].slice(0, 6);
  trimTagVideoLists(tag);
  saveState();
  return state.tagVideoLists[tag] || { videos: videosForTag };
}

function selectDiscoveryTag() {
  const ranked = Object.entries(state.tagInterests)
    .filter(([, value]) => Number.isFinite(value) && value > 0)
    .sort((left, right) => right[1] - left[1])
    .slice(0, discoveryTagLimit);
  const eligible = ranked.length > recentSearchTagLimit
    ? ranked.filter(([tag]) => !state.recentSearchTags.includes(tag))
    : ranked;
  const selectedTag = chooseWeightedTag(eligible);
  console.info("[tagInterests] Selected discovery tag", {
    selectedTag,
    ranked,
    interests: state.tagInterests
  });
  return selectedTag;
}

function chooseWeightedTag(entries) {
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  let target = Math.random() * total;
  for (const [tag, value] of entries) {
    target -= value;
    if (target <= 0) {
      return tag;
    }
  }
  return entries[0]?.[0] || "";
}

function createPlaybackState(video) {
  return {
    videoId: video?.id || "",
    totalSeconds: 0,
    lastPosition: null,
    duration: video?.duration || 0,
    finalized: false
  };
}

function requestPlaybackInfo() {
  sendPlayerCommand("getCurrentTime");
  sendPlayerCommand("getDuration");
}

function updatePlaybackInfo(info) {
  if (!currentVideo || playback.videoId !== currentVideo.id) {
    return;
  }
  const position = Number(info.currentTime);
  const duration = Number(info.duration);
  if (Number.isFinite(duration) && duration > 0) {
    playback.duration = duration;
  }
  if (!Number.isFinite(position)) {
    return;
  }
  if (state.isPlaying && playback.lastPosition !== null) {
    const elapsed = position - playback.lastPosition;
    if (elapsed > 0 && elapsed <= playbackPollMs / 1000 + 3) {
      playback.totalSeconds += elapsed;
    }
  }
  playback.lastPosition = position;
}

function watchedAtLeastHalf() {
  const duration = playback.duration || currentVideo?.duration || 0;
  return duration > 0 && playback.totalSeconds >= duration / 2;
}

function finalizeCurrentVideo() {
  if (queuedVideo) {
    const video = queuedVideo;
    queuedVideo = null;
    moveDiscoveryVideoToBack(video);
    updateTagInterests(video, minimumTrackedPlaybackSeconds);
    saveState();
    return;
  }

  if (!currentVideo || playback.videoId !== currentVideo.id || playback.finalized) {
    return;
  }
  playback.finalized = true;
  moveDiscoveryVideoToBack(currentVideo);

  const duration = playback.duration || currentVideo.duration || 0;
  if (
    playback.totalSeconds < minimumTrackedPlaybackSeconds ||
    (duration > 0 && duration < shortVideoSeconds && playback.totalSeconds < duration / 2)
  ) {
    saveState();
    return;
  }

  updateTagInterests(currentVideo, playback.totalSeconds);
  saveState();
}

function updateTagInterests(video, playbackSeconds) {
  const tags = [...new Set(video.tags?.length ? video.tags : [video.discoveryTag])].filter(Boolean);
  tags.forEach((tag, index) => {
    state.tagInterests[tag] = (state.tagInterests[tag] || 0) +
      Math.sqrt(playbackSeconds / 300) * Math.pow(0.9, index);
  });
  console.info("[tagInterests] Updated after playback", {
    videoId: video.id,
    playbackSeconds,
    tags,
    interests: state.tagInterests
  });
  trimTagInterests();
}

function moveDiscoveryVideoToBack(video) {
  if (!video.discoveryTag) {
    return;
  }
  const group = state.tagVideoLists[video.discoveryTag];
  if (!group?.videos) {
    return;
  }
  const index = group.videos.findIndex((item) => item.id === video.id);
  if (index >= 0) {
    group.videos.push(group.videos.splice(index, 1)[0]);
  }
}

function decayTagInterestsForNewDay() {
  const today = new Date().toISOString().slice(0, 10);
  if (!state.lastUsageDate) {
    state.lastUsageDate = today;
    saveState();
    return;
  }
  if (state.lastUsageDate === today) {
    return;
  }
  const elapsedDays = Math.max(
    0,
    Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${state.lastUsageDate}T00:00:00Z`)) / 86400000)
  );
  const multiplier = (365 - Math.min(elapsedDays, 180)) / 365;
  for (const tag of Object.keys(state.tagInterests)) {
    state.tagInterests[tag] *= multiplier;
  }
  console.info("[tagInterests] Applied daily decay", {
    elapsedDays,
    multiplier,
    interests: state.tagInterests
  });
  state.lastUsageDate = today;
  trimTagInterests();
  saveState();
}

function trimTagInterests() {
  const tagsToRemove = Object.entries(state.tagInterests)
    .sort((left, right) => left[1] - right[1])
    .slice(0, Math.max(0, Object.keys(state.tagInterests).length - tagInterestLimit))
    .map(([tag]) => tag);
  for (const tag of tagsToRemove) {
    delete state.tagInterests[tag];
  }
  trimTagVideoLists();
}

function trimTagVideoLists(protectedTag = "") {
  const tagsToRemove = Object.keys(state.tagVideoLists)
    .filter((tag) => tag !== protectedTag)
    .sort((left, right) => (state.tagInterests[left] || 0) - (state.tagInterests[right] || 0))
    .slice(0, Math.max(0, Object.keys(state.tagVideoLists).length - discoveryTagLimit));
  for (const tag of tagsToRemove) {
    delete state.tagVideoLists[tag];
  }
}

function parseYouTubeDuration(value) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value || "");
  if (!match) {
    return 0;
  }
  return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
}

async function loadVideoMetadata(video) {
  if (video.tags?.length && video.duration) {
    return;
  }
  try {
    const data = await fetchYouTube("videos", {
      part: "snippet,contentDetails",
      id: video.id
    });
    const metadata = data.items?.[0];
    if (!metadata || currentVideo?.id !== video.id) {
      return;
    }
    video.tags = Array.isArray(metadata.snippet?.tags) ? metadata.snippet.tags : video.tags || [];
    video.duration = parseYouTubeDuration(metadata.contentDetails?.duration) || video.duration || 0;
    playback.duration = video.duration;
  } catch (error) {
    console.error(error);
  }
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
    volume: defaultVolume,
    tagInterests: {},
    tagVideoLists: {},
    recentSearchTags: [],
    lastUsageDate: "",
    initialSetupCompleted: false
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
