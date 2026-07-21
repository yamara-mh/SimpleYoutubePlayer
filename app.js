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
  "エンターテインメント", "お笑い", "バライティ", "コント", "落語", "時代劇",
  "ペット", "犬", "猫", "小動物", "アクアリウム",
  "趣味", "料理", "簡単レシピ", "手芸", "家庭菜園", "DIY", "お絵描き", "カメラ", "園芸", "盆栽",
  "健康", "シニア", "体操", "ストレッチ", "ヨガ", "筋トレ", "医療", "快眠", "認知症予防", "脳トレ", "栄養学",
  "暮らしの知恵", "便利グッズ", "新商品", "スマホの使い方", "節約", "老後の資金",
  "日常", "散歩", "旅行", "グルメ", "ドライブ", "キャンプ", "移住", "絶景", "海外", "営業風景", "工場見学", "リフォーム",
  "音楽", "ヒット曲", "名曲", "演歌", "歌謡曲", "昭和ポップス", "クラシック", "演奏",
  "囲碁", "将棋", "麻雀", "ゲーム", "漫画", "アニメ", "ドラマ", "ドキュメンタリー", "映画", "考察", "感動", "ミステリー", "衝撃映像",
  "政治", "金融", "経済", "雑学", "哲学", "心理学", "解説", "本要約", "技術", "美術", "語学", "歴史", "地理", "IT", "AI", "宇宙",
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
  settingsOverlay: document.getElementById("settingsOverlay"),
  settingsCloseButton: document.getElementById("settingsCloseButton"),
  historyButton: document.getElementById("historyButton"),
  editTagsButton: document.getElementById("editTagsButton"),
  clearTagsButton: document.getElementById("clearTagsButton"),
  historyOverlay: document.getElementById("historyOverlay"),
  historyBackButton: document.getElementById("historyBackButton"),
  historyList: document.getElementById("historyList"),
  tagEditOverlay: document.getElementById("tagEditOverlay"),
  tagEditBackButton: document.getElementById("tagEditBackButton"),
  tagEditSaveButton: document.getElementById("tagEditSaveButton"),
  tagEditList: document.getElementById("tagEditList"),
  tagDoubleButton: document.getElementById("tagDoubleButton"),
  tagHalfButton: document.getElementById("tagHalfButton"),
  tagDeleteButton: document.getElementById("tagDeleteButton"),
  playToggle: document.getElementById("playToggle"),
  volumeDown: document.getElementById("volumeDown"),
  volumeUp: document.getElementById("volumeUp"),
  volumeLevel: document.getElementById("volumeLevel"),
  moreButton: document.getElementById("moreButton"),
  discoverButton: document.getElementById("discoverButton"),
  controlSizeToggle: document.getElementById("controlSizeToggle"),
  appShell: document.querySelector(".app-shell")
};

const state = loadState();
const player = document.getElementById("player");
let playerLoaded = false;
let currentVideo = null;
let previewTimer = null;
let playback = createPlaybackState();
let playbackPollTimer = null;
let discoveryButtonsBusy = false;
let editingTagInterests = null;
let returnToSettingsAfterSetup = false;
let playGesture = null;
let suppressPlayClick = false;

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
    if (playback.resumePosition > 0) {
      sendPlayerCommand("seekTo", [playback.resumePosition, true]);
    }
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
    setControlButtonContent(elements.playToggle, "⏸️", "止める");
    saveState();
    return;
  }

  if (stateCode === 2 || stateCode === 0) {
    state.isPlaying = false;
    setControlButtonContent(elements.playToggle, "▶️", "再生");
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
  elements.playToggle.addEventListener("click", handlePlayToggleClick);
  elements.playToggle.addEventListener("pointerdown", startPlayGesture);
  elements.playToggle.addEventListener("pointermove", trackPlayGesture);
  elements.playToggle.addEventListener("pointerup", finishPlayGesture);
  elements.playToggle.addEventListener("pointercancel", cancelPlayGesture);
  elements.volumeDown.addEventListener("click", () => changeVolume(-1));
  elements.volumeUp.addEventListener("click", () => changeVolume(1));
  elements.moreButton.addEventListener("click", playMoreVideos);
  elements.discoverButton.addEventListener("click", discoverVideo);
  elements.controlSizeToggle.addEventListener("click", toggleControlSize);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      openSettings();
    }
  });
  elements.settingsCloseButton.addEventListener("click", closeModals);
  elements.historyButton.addEventListener("click", openHistory);
  elements.editTagsButton.addEventListener("click", openTagEditor);
  elements.clearTagsButton.addEventListener("click", clearAllTags);
  elements.historyBackButton.addEventListener("click", openSettings);
  elements.tagEditBackButton.addEventListener("click", confirmDiscardTagEdits);
  elements.tagEditSaveButton.addEventListener("click", saveTagEdits);
  elements.tagDoubleButton.addEventListener("click", () => changeSelectedTags(2));
  elements.tagHalfButton.addEventListener("click", () => changeSelectedTags(0.5));
  elements.tagDeleteButton.addEventListener("click", () => changeSelectedTags(0));
  window.addEventListener("beforeunload", finalizeCurrentVideo);
}

function handlePlayToggleClick() {
  if (suppressPlayClick) {
    suppressPlayClick = false;
    return;
  }
  togglePlayback();
}

function startPlayGesture(event) {
  const rect = elements.playToggle.getBoundingClientRect();
  playGesture = {
    pointerId: event.pointerId,
    centerX: rect.left + rect.width / 2,
    centerY: rect.top + rect.height / 2,
    lastAngle: null,
    rotation: 0,
    distance: 0
  };
  elements.playToggle.setPointerCapture?.(event.pointerId);
}

function trackPlayGesture(event) {
  if (!playGesture || event.pointerId !== playGesture.pointerId) {
    return;
  }

  const distanceX = event.clientX - playGesture.centerX;
  const distanceY = event.clientY - playGesture.centerY;
  const distance = Math.hypot(distanceX, distanceY);
  if (distance < 8) {
    return;
  }

  const angle = Math.atan2(distanceY, distanceX);
  if (playGesture.lastAngle !== null) {
    let delta = angle - playGesture.lastAngle;
    if (delta > Math.PI) delta -= Math.PI * 2;
    if (delta < -Math.PI) delta += Math.PI * 2;
    playGesture.rotation += delta;
  }
  playGesture.lastAngle = angle;
  playGesture.distance += distance;
}

function finishPlayGesture(event) {
  if (!playGesture || event.pointerId !== playGesture.pointerId) {
    return;
  }

  const completed = playGesture.rotation <= -Math.PI * 3.5 && playGesture.distance >= 80;
  playGesture = null;
  if (completed) {
    suppressPlayClick = true;
    openSettings();
  }
}

function cancelPlayGesture() {
  playGesture = null;
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
  if (returnToSettingsAfterSetup) {
    returnToSettingsAfterSetup = false;
    openSettings();
  }
}

function canOpenSettings() {
  return Boolean(accessToken && state.initialSetupCompleted);
}

function openSettings() {
  if (!canOpenSettings()) {
    return;
  }
  sendPlayerCommand("pauseVideo");
  state.isPlaying = false;
  renderStaticState();
  saveState();
  closeModals();
  elements.settingsOverlay.classList.remove("hidden");
}

function openHistory() {
  renderHistory();
  elements.settingsOverlay.classList.add("hidden");
  elements.historyOverlay.classList.remove("hidden");
}

function openTagEditor() {
  editingTagInterests = { ...state.tagInterests };
  renderTagEditor();
  elements.settingsOverlay.classList.add("hidden");
  elements.tagEditOverlay.classList.remove("hidden");
}

function closeModals() {
  for (const overlay of [elements.settingsOverlay, elements.historyOverlay, elements.tagEditOverlay]) {
    overlay.classList.add("hidden");
  }
  editingTagInterests = null;
}

function renderHistory() {
  const entries = Array.isArray(state.history) ? state.history : [];
  elements.historyList.replaceChildren(
    ...entries.slice().reverse().map((entry) => {
      const item = document.createElement("div");
      item.className = "history-item";
      item.tabIndex = 0;
      item.addEventListener("click", (event) => {
        if (event.target.closest(".history-youtube, .history-delete")) return;
        playHistoryEntry(entry);
      });
      item.addEventListener("keydown", (event) => {
        if (event.target.closest(".history-youtube, .history-delete")) return;
        if (event.key === "Enter" || event.key === " ") playHistoryEntry(entry);
      });
      const image = document.createElement("img");
      image.src = thumbnailUrl(entry.video.id);
      image.alt = `${entry.video.title} のサムネイル`;
      const remove = document.createElement("button");
      remove.className = "history-delete danger-button";
      remove.type = "button";
      remove.textContent = "削除";
      remove.addEventListener("click", () => removeHistoryEntry(entry));
      const copy = document.createElement("div");
      copy.className = "history-copy";
      const title = document.createElement("strong");
      title.textContent = entry.video.title;
      const details = document.createElement("small");
      details.textContent = `${new Date(entry.startedAt).toLocaleString("ja-JP")} / ${formatPosition(entry.position, entry.duration)}`;
      copy.append(title, details);
      const youtube = document.createElement("button");
      youtube.className = "history-youtube";
      youtube.type = "button";
      youtube.textContent = "YouTube";
      youtube.addEventListener("click", () => window.open(`https://www.youtube.com/watch?v=${encodeURIComponent(entry.video.id)}`, "_blank", "noopener"));
      item.append(remove, image, copy, youtube);
      return item;
    })
  );
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.textContent = "視聴履歴はありません。";
    elements.historyList.append(empty);
  }
}

function removeHistoryEntry(entry) {
  state.history = (state.history || []).filter((candidate) => candidate !== entry);
  saveState();
  renderHistory();
}

function formatPosition(position, duration) {
  const value = Math.max(0, Math.floor(Number(position) || 0));
  const total = Math.max(0, Math.floor(Number(duration) || 0));
  const format = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return `再生位置 ${format(value)}${total ? ` / ${format(total)}` : ""}`;
}

function playHistoryEntry(entry) {
  closeModals();
  finalizeCurrentVideo();
  const video = { ...entry.video };
  queueVideo(video, {
    recordHistory: false,
    historyIndexOverride: state.historyIds.indexOf(video.id),
    resumePosition: Number(entry.position) || 0,
    previewDelayMs: 0,
    assistText: "履歴から再生しています"
  });
}

function renderTagEditor() {
  const interests = editingTagInterests || {};
  elements.tagEditList.replaceChildren(
    ...Object.entries(interests).sort((a, b) => b[1] - a[1]).map(([tag, value], index) => {
      const wrapper = document.createElement("div");
      wrapper.className = "interest-tag";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.id = `edit-tag-${index}`;
      input.value = tag;
      const label = document.createElement("label");
      label.htmlFor = input.id;
      label.textContent = `${tag} (${value.toFixed(1)})`;
      wrapper.append(input, label);
      return wrapper;
    })
  );
}

function changeSelectedTags(multiplier) {
  if (!editingTagInterests) return;
  const selectedTags = new Set(
    [...elements.tagEditList.querySelectorAll("input:checked")].map((input) => input.value)
  );
  for (const tag of selectedTags) {
    if (multiplier === 0) delete editingTagInterests[tag];
    else editingTagInterests[tag] *= multiplier;
  }
  renderTagEditor();
  for (const input of elements.tagEditList.querySelectorAll("input")) {
    input.checked = selectedTags.has(input.value) && multiplier !== 0;
  }
}

function saveTagEdits() {
  if (!editingTagInterests || !Object.keys(editingTagInterests).length) {
    window.alert("タグを1つ以上残してください。");
    return;
  }
  state.tagInterests = { ...editingTagInterests };
  trimTagInterests();
  saveState();
  openSettings();
}

function confirmDiscardTagEdits() {
  if (window.confirm("タグを編集せずに戻りますか？")) openSettings();
}

function clearAllTags() {
  if (!window.confirm("タグリストを全て削除します。よく分からなければ「キャンセル」を押してください。")) return;
  if (!window.confirm("タグリストはこれまであなたが見た動画の傾向を記録した情報です。削除するとあなたの好みに合わせた動画が再生されなくなります。よく分からなければ「キャンセル」を押してください。")) return;
  if (!window.confirm("削除すると元に戻せません。本当に削除しますか？")) return;
  state.tagInterests = {};
  state.initialSetupCompleted = false;
  returnToSettingsAfterSetup = true;
  saveState();
  closeModals();
  renderInterestSetup();
  showInterestSetup();
}

function renderStaticState() {
  elements.volumeLevel.textContent = String(state.volume);
  setControlButtonContent(elements.playToggle, state.isPlaying ? "⏸️" : "▶️", state.isPlaying ? "停止" : "再生");
}

function setControlButtonContent(button, emoji, label) {
  button.querySelector(".control-emoji").textContent = emoji;
  button.querySelector(".control-label").textContent = label;
}

function toggleControlSize() {
  const isCompact = elements.appShell.classList.toggle("compact-controls");
  elements.controlSizeToggle.setAttribute("aria-pressed", String(isCompact));
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
  if (options.recordHistory) {
    const historyEntry = {
      video: { ...video },
      startedAt: Date.now(),
      position: 0,
      duration: video.duration || 0
    };
    options.historyEntry = historyEntry;
    state.history = [...(state.history || []), historyEntry].slice(-1000);
    const nextHistory = state.historyIds.slice(0, state.historyIndex + 1);
    nextHistory.push(video.id);
    state.historyIds = nextHistory;
    state.historyIndex = state.historyIds.length - 1;
    saveState();
  }
  showPreview(video, options.assistText);
  previewTimer = window.setTimeout(() => {
    startVideo(video, options);
  }, options.previewDelayMs ?? previewDelayMs);
}

function startVideo(video, options) {
  queuedVideo = null;
  currentVideo = video;
  playback = createPlaybackState(video);
  playback.resumePosition = Number(options.resumePosition) || 0;
  loadVideoMetadata(video);
  hidePreview();

  if (typeof options.historyIndexOverride === "number") {
    state.historyIndex = options.historyIndexOverride;
  }

  state.lastVideoId = video.id;
  state.lastWatchedAt[video.id] = Date.now();
  const historyEntry = options.historyEntry || {
    video: { ...video },
    startedAt: Date.now(),
    position: playback.resumePosition,
    duration: video.duration || 0
  };
  if (!options.historyEntry) {
    const existing = (state.history || []).find((entry) => entry.video?.id === video.id);
    playback.historyEntry = existing || historyEntry;
  }
  playback.historyEntry = playback.historyEntry || historyEntry;
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
    finalized: false,
    resumePosition: 0,
    historyEntry: null
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
  if (playback.historyEntry) {
    playback.historyEntry.position = position;
    playback.historyEntry.duration = playback.duration;
    saveState();
  }
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
    history: [],
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
