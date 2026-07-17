function normalizeCreator(creator) {
  const defaultCategoryId = creator.defaultCategoryId || "24";
  const defaultTags = sanitizeTags(creator.defaultTags || []);

  return {
    ...creator,
    defaultCategoryId,
    defaultTags,
    playlists: creator.playlists
      .slice()
      .sort((left, right) => right.popularity - left.popularity)
      .map((playlist) => normalizePlaylist(creator, playlist, defaultCategoryId, defaultTags))
  };
}

function normalizePlaylist(creator, playlist, inheritedCategoryId, inheritedTags) {
  const ordered = resolvePlaylistPlaybackOrder(playlist.videos);
  const playlistTags = sanitizeTags([...(inheritedTags || []), ...(playlist.tags || [])]);
  const categoryId = playlist.categoryId || inheritedCategoryId || "24";

  return {
    ...playlist,
    creatorId: creator.id,
    creatorName: creator.name,
    categoryId,
    tags: playlistTags,
    playbackMode: ordered.mode,
    orderedVideos: ordered.videos.map((video, index) => {
      const tags = sanitizeTags([...(playlistTags || []), ...(video.tags || []), video.title]);
      return {
        ...video,
        channel: creator.name,
        channelId: video.channelId || creator.channelId || "",
        creatorId: creator.id,
        playlistId: playlist.id,
        playlistTitle: playlist.title,
        playbackIndex: index,
        categoryId: video.categoryId || categoryId,
        tags,
        durationSeconds: video.durationSeconds || 0
      };
    })
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
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("beforeunload", () => finalizeWatchSession({ ended: false }));

  initializeInitialPlayback().catch(() => {});
}

async function initializeInitialPlayback() {
  await refreshCategoryCatalogIfNeeded();

  const storedPlayback = resolveInitialPlayback();
  if (storedPlayback) {
    queuePlayback(storedPlayback);
    return;
  }

  const categoryId = state.currentVideoCategoryId || defaultCategoryId();
  const fetchedPlayback = await getCategoryPlayback(categoryId, { preferNext: false, forceRefresh: false });
  if (fetchedPlayback) {
    queuePlayback(fetchedPlayback);
  }
}

function onYouTubeMessage(event) {
  if (event.origin !== "https://www.youtube.com") {
    return;
  }

  let data;
  try {
    data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
  } catch (_error) {
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
    return;
  }

  if (data.event === "infoDelivery") {
    const info = data.info || {};
    if (Number.isFinite(info.duration) && info.duration > 0) {
      lastKnownDurationSeconds = info.duration;
      if (currentVideo) {
        currentVideo.durationSeconds = Math.max(currentVideo.durationSeconds || 0, info.duration);
      }
    }
    if (Number.isFinite(info.currentTime)) {
      lastKnownCurrentSeconds = info.currentTime;
    }
  }
}

function handlePlayerStateChange(stateCode) {
  if (stateCode === 1) {
    maybeDecayInterestsOnDateChange();
    startWatchSession();
    state.isPlaying = true;
    elements.playToggle.innerHTML = "⏸️<br>停止";
    saveState();
    return;
  }

  if (stateCode === 2) {
    pauseWatchSession();
    state.isPlaying = false;
    elements.playToggle.innerHTML = "▶️<br>再生";
    saveState();
    return;
  }

  if (stateCode === 0) {
    finalizeWatchSession({ ended: true });
    state.isPlaying = false;
    elements.playToggle.innerHTML = "▶️<br>再生";
    saveState();

    const nextPlayback = findNextSequentialPlayback(getCurrentPlayback());
    if (nextPlayback) {
      queuePlayback(nextPlayback);
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
  elements.moreButton.addEventListener("click", playMoreVideos);
  elements.searchButton.addEventListener("click", playSearchDecision);
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
    return;
  }

  sendPlayerCommand("playVideo");
}

function changeVolume(delta) {
  state.volume = clamp(state.volume + delta, 0, 9);
  applyVolume();
  renderStaticState();
  saveState();
}

function applyVolume() {
  elements.volumeLevel.textContent = String(state.volume);
  sendPlayerCommand("setVolume", [Math.round((state.volume / 9) * 100)]);
}

async function playMoreVideos() {
  finalizeWatchSession({ ended: false });

  if (queuedPlayback) {
    const alternatePlayback = findAlternativePlaylistPlayback(queuedPlayback);
    if (alternatePlayback) {
      queuePlayback(alternatePlayback);
      return;
    }

    if (isFetchingPlaylists) {
      return;
    }
    isFetchingPlaylists = true;

    const creator = creatorMap.get(queuedPlayback.creatorId);
    if (creator) {
      try {
        if (creator.playlists.length === 0) {
          await loadUploadsPlaylist(creator);
        } else {
          await loadMorePlaylists(creator);
        }
      } finally {
        isFetchingPlaylists = false;
      }

      const newAlternatePlayback = findAlternativePlaylistPlayback(queuedPlayback);
      if (newAlternatePlayback) {
        queuePlayback(newAlternatePlayback);
      }
    } else {
      isFetchingPlaylists = false;
    }
    return;
  }

  const nextPlayback = findNextSequentialPlayback(getCurrentPlayback());
  if (!nextPlayback) {
    return;
  }

  queuePlayback(nextPlayback);
}

async function playSearchDecision() {
  if (!currentVideo) {
    return;
  }

  const watchSeconds = getCurrentWatchSeconds();
  const durationSeconds = resolveDurationSeconds();
  const halfWatched = durationSeconds > 0 && watchSeconds >= durationSeconds / 2;

  if (watchSeconds >= 60) {
    recentSelectedCategories.length = 0;
  }

  finalizeWatchSession({ ended: false });

  if (halfWatched) {
    await playMoreVideos();
    return;
  }

  if (watchSeconds < 0.8) {
    const categoryId = selectCategoryForQuickSwitch();
    const playback = await getCategoryPlayback(categoryId, { preferNext: false, forceRefresh: false });
    if (playback) {
      queuePlayback(playback);
    }
    return;
  }

  if (watchSeconds < 10) {
    const categoryId = currentVideo.categoryId || state.currentVideoCategoryId || defaultCategoryId();
    const playback = await getCategoryPlayback(categoryId, { preferNext: true, forceRefresh: false });
    if (playback) {
      queuePlayback(playback);
    }
    return;
  }

  const relatedPlayback = await getRelatedUploadsPlayback(currentVideo);
  if (relatedPlayback) {
    queuePlayback(relatedPlayback);
    return;
  }

  const fallbackCategory = currentVideo.categoryId || state.currentVideoCategoryId || defaultCategoryId();
  const fallbackPlayback = await getCategoryPlayback(fallbackCategory, { preferNext: true, forceRefresh: false });
  if (fallbackPlayback) {
    queuePlayback(fallbackPlayback);
  }
}

function queuePlayback(playback) {
  const video = getVideoForPlayback(playback);
  if (!video) {
    return;
  }

  clearPreviewTimer();
  queuedPlayback = playback;
  showPreview(video);
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
  state.currentVideoCategoryId = video.categoryId || defaultCategoryId();
  state.currentVideoChannelId = video.channelId || "";
  saveState();

  resetWatchClock();
  hidePreview();
  loadYouTubeVideo(video.id);
  applyVolume();
  ensureVideoMetadata(video).catch(() => {});
}

function showPreview(video) {
  elements.previewImage.src = thumbnailUrl(video.id);
  elements.previewTitle.textContent = video.title;
  elements.previewMeta.textContent = `${video.channel} ・ ${video.playlistTitle}`;
  elements.previewOverlay.classList.remove("hidden");
}

function hidePreview() {
  elements.previewOverlay.classList.add("hidden");
}

function resolveInitialPlayback() {
  return findStoredPlayback();
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
  if (!creator || creator.playlists.length === 0) {
    return null;
  }

  const currentIndex = creator.playlists.findIndex((playlist) => playlist.id === playback.playlistId);
  const nextIndex = currentIndex + 1;

  if (nextIndex < creator.playlists.length) {
    return { creatorId: creator.id, playlistId: creator.playlists[nextIndex].id, videoIndex: 0 };
  }

  const pageState = getCreatorPageState(creator.id);
  if (pageState.allLoaded) {
    return { creatorId: creator.id, playlistId: creator.playlists[0].id, videoIndex: 0 };
  }

  return null;
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


function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getCreatorPageState(creatorId) {
  if (!creatorPageState.has(creatorId)) {
    const creator = creatorMap.get(creatorId);
    creatorPageState.set(creatorId, { nextPageToken: null, allLoaded: !creator?.channelId });
  }
  return creatorPageState.get(creatorId);
}

function addPlaylistToCreator(creator, playlistData) {
  const normalized = normalizePlaylist(
    creator,
    playlistData,
    creator.defaultCategoryId || defaultCategoryId(),
    creator.defaultTags || []
  );
  creator.playlists.push(normalized);
  playlistMap.set(normalized.id, normalized);
  for (const video of normalized.orderedVideos) {
    videoMap.set(video.id, video);
  }
}

async function loadUploadsPlaylist(creator) {
  if (!creator.channelId || !youtubeApiKey) {
    getCreatorPageState(creator.id).allLoaded = true;
    return;
  }

  try {
    const params = new URLSearchParams({ part: "contentDetails", id: creator.channelId, key: youtubeApiKey });
    const channelData = await fetchYouTubeApi(`https://www.googleapis.com/youtube/v3/channels?${params}`);
    const uploadsId = channelData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsId) {
      getCreatorPageState(creator.id).allLoaded = true;
      return;
    }

    const videoItems = await fetchPlaylistItems(uploadsId);
    const videos = videoItems.map((item) => ({
      id: item.snippet.resourceId.videoId,
      title: item.snippet.title,
      publishedAt: item.snippet.publishedAt,
      channelId: item.snippet.channelId,
      categoryId: creator.defaultCategoryId,
      tags: creator.defaultTags
    }));

    addPlaylistToCreator(creator, {
      id: uploadsId,
      title: `${creator.name} uploads`,
      popularity: 0,
      categoryId: creator.defaultCategoryId,
      tags: creator.defaultTags,
      videos
    });
  } catch (_error) {
    // no-op
  }

  getCreatorPageState(creator.id).allLoaded = true;
}

async function loadMorePlaylists(creator) {
  if (!creator.channelId || !youtubeApiKey) {
    getCreatorPageState(creator.id).allLoaded = true;
    return;
  }

  const pageState = getCreatorPageState(creator.id);

  try {
    const params = new URLSearchParams({
      part: "snippet",
      channelId: creator.channelId,
      maxResults: "50",
      key: youtubeApiKey
    });
    if (pageState.nextPageToken) {
      params.set("pageToken", pageState.nextPageToken);
    }

    const playlistsData = await fetchYouTubeApi(`https://www.googleapis.com/youtube/v3/playlists?${params}`);

    for (const item of playlistsData.items || []) {
      const videoItems = await fetchPlaylistItems(item.id);
      const videos = videoItems.map((v) => ({
        id: v.snippet.resourceId.videoId,
        title: v.snippet.title,
        publishedAt: v.snippet.publishedAt,
        channelId: v.snippet.channelId,
        categoryId: creator.defaultCategoryId,
        tags: creator.defaultTags
      }));
      addPlaylistToCreator(creator, {
        id: item.id,
        title: item.snippet.title,
        popularity: 0,
        categoryId: creator.defaultCategoryId,
        tags: creator.defaultTags,
        videos
      });
    }

    pageState.nextPageToken = playlistsData.nextPageToken || null;
    pageState.allLoaded = !playlistsData.nextPageToken;
  } catch (_error) {
    pageState.allLoaded = true;
  }
}

async function fetchYouTubeApi(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`YouTube API request failed: ${response.status}`);
  }
  return response.json();
}

async function fetchPlaylistItems(playlistId) {
  const params = new URLSearchParams({ part: "snippet", playlistId, maxResults: "50", key: youtubeApiKey });
  const data = await fetchYouTubeApi(`https://www.googleapis.com/youtube/v3/playlistItems?${params}`);
  return (data.items || []).filter((item) => item.snippet?.resourceId?.kind === "youtube#video");
}

function cloneCategoryCatalogEntries(entries) {
  const unique = new Map();
  for (const entry of entries || []) {
    const id = String(entry?.id || "").trim();
    const label = String(entry?.label || "").trim();
    if (!id || !label) {
      continue;
    }
    if (!unique.has(id)) {
      unique.set(id, { id, label });
    }
  }
  return Array.from(unique.values());
}

function readStoredCategoryCatalog() {
  try {
    const raw = window.localStorage.getItem(categoryCatalogStorageKey);
    if (!raw) {
      return { fetchedAt: 0, entries: [] };
    }

    const parsed = JSON.parse(raw);
    const fetchedAt = Number(parsed?.fetchedAt);
    const entries = cloneCategoryCatalogEntries(parsed?.entries);
    return {
      fetchedAt: Number.isFinite(fetchedAt) && fetchedAt > 0 ? fetchedAt : 0,
      entries
    };
  } catch (_error) {
    return { fetchedAt: 0, entries: [] };
  }
}

function writeStoredCategoryCatalog(entries, fetchedAt) {
  try {
    window.localStorage.setItem(
      categoryCatalogStorageKey,
      JSON.stringify({
        fetchedAt,
        entries
      })
    );
  } catch (_error) {
    // no-op
  }
}

async function fetchCategoryCatalogFromApi() {
  if (!youtubeApiKey) {
    return [];
  }

  const params = new URLSearchParams({
    part: "snippet",
    regionCode: "JP",
    key: youtubeApiKey
  });

  const data = await fetchYouTubeApi(`https://www.googleapis.com/youtube/v3/videoCategories?${params}`);
  return cloneCategoryCatalogEntries(
    (data.items || [])
      .filter((item) => item?.snippet?.assignable !== false)
      .map((item) => ({
        id: item.id,
        label: item.snippet?.title || ""
      }))
  );
}

async function refreshCategoryCatalogIfNeeded(forceRefresh = false) {
  const now = Date.now();
  const stored = readStoredCategoryCatalog();
  if (stored.entries.length) {
    categoryCatalog = stored.entries;
  }

  const shouldFetch = forceRefresh || !stored.fetchedAt || now - stored.fetchedAt >= categoryCatalogRefreshMs;
  if (!shouldFetch || !youtubeApiKey) {
    if (!categoryCatalog.length) {
      categoryCatalog = fallbackCategoryCatalog.map((entry) => ({ ...entry }));
    }
    return;
  }

  try {
    const fetched = await fetchCategoryCatalogFromApi();
    if (fetched.length) {
      categoryCatalog = fetched;
      writeStoredCategoryCatalog(fetched, now);
      return;
    }
  } catch (_error) {
    // no-op
  }

  if (!categoryCatalog.length) {
    categoryCatalog = fallbackCategoryCatalog.map((entry) => ({ ...entry }));
  }
}

function defaultCategoryId() {
  return "24";
}

function sanitizeTags(tags) {
  return Array.from(
    new Set(
      (tags || [])
        .flatMap((tag) => String(tag || "").split(/[\s、,，／/|]+/g))
        .map((tag) => tag.trim())
        .filter(Boolean)
    )
  );
}


function maybeDecayInterestsOnDateChange() {
  const today = currentDateKey();
  if (!state.lastInterestDecayDate) {
    state.lastInterestDecayDate = today;
    saveState();
    return;
  }

  if (state.lastInterestDecayDate === today) {
    return;
  }

  const elapsedDays = daysBetween(state.lastInterestDecayDate, today);
  if (elapsedDays <= 0) {
    state.lastInterestDecayDate = today;
    saveState();
    return;
  }

  const boundedDays = Math.min(elapsedDays, 180);
  const factor = (365 - boundedDays) / 365;

  multiplyMapValues(state.interestTags, factor);
  multiplyMapValues(state.categoryInterests, factor);
  pruneInterestTagsToLimit(1024);

  state.lastInterestDecayDate = today;
  saveState();
}

function currentDateKey() {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(fromDateKey, toDateKey) {
  const from = Date.parse(`${fromDateKey}T00:00:00Z`);
  const to = Date.parse(`${toDateKey}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return 0;
  }
  return Math.floor((to - from) / 86400000);
}

function multiplyMapValues(mapObject, factor) {
  for (const key of Object.keys(mapObject)) {
    mapObject[key] *= factor;
    if (!Number.isFinite(mapObject[key]) || mapObject[key] <= 0.0001) {
      delete mapObject[key];
    }
  }
}

function pruneInterestTagsToLimit(limit) {
  const entries = Object.entries(state.interestTags);
  if (entries.length <= limit) {
    return;
  }

  entries.sort((left, right) => left[1] - right[1]);
  for (let index = 0; index < entries.length - limit; index += 1) {
    delete state.interestTags[entries[index][0]];
  }
}

function startWatchSession() {
  if (!watchSessionStartedAt) {
    watchSessionStartedAt = Date.now();
  }
}

function pauseWatchSession() {
  if (!watchSessionStartedAt) {
    return;
  }
  accumulatedWatchSeconds += (Date.now() - watchSessionStartedAt) / 1000;
  watchSessionStartedAt = 0;
}

function resetWatchClock() {
  watchSessionStartedAt = 0;
  accumulatedWatchSeconds = 0;
  lastKnownDurationSeconds = currentVideo?.durationSeconds || 0;
  lastKnownCurrentSeconds = 0;
}

function getCurrentWatchSeconds() {
  let seconds = accumulatedWatchSeconds;
  if (watchSessionStartedAt) {
    seconds += (Date.now() - watchSessionStartedAt) / 1000;
  }
  if (Number.isFinite(lastKnownCurrentSeconds) && lastKnownCurrentSeconds > seconds) {
    seconds = lastKnownCurrentSeconds;
  }
  return Math.max(0, seconds);
}

function resolveDurationSeconds() {
  const candidates = [lastKnownDurationSeconds, currentVideo?.durationSeconds || 0];
  for (const candidate of candidates) {
    if (Number.isFinite(candidate) && candidate > 0) {
      return candidate;
    }
  }
  return 0;
}

function finalizeWatchSession({ ended }) {
  if (!currentVideo) {
    resetWatchClock();
    return;
  }

  pauseWatchSession();

  const watchedSeconds = getCurrentWatchSeconds();
  const durationSeconds = resolveDurationSeconds();
  const shouldRecord = durationSeconds >= 15 || ended;

  if (shouldRecord && watchedSeconds > 0) {
    updateInterestFromVideo(currentVideo, watchedSeconds);
  }

  if (watchedSeconds >= 60) {
    recentSelectedCategories.length = 0;
  }

  saveState();
  resetWatchClock();
}

function updateInterestFromVideo(video, watchedSeconds) {
  const tags = sanitizeTags(video.tags || []);
  let factor = 1;
  for (const tag of tags) {
    const current = state.interestTags[tag] || 0;
    state.interestTags[tag] = current + watchedSeconds * factor;
    factor *= 0.9;
  }

  const categoryId = video.categoryId || defaultCategoryId();
  state.categoryInterests[categoryId] = (state.categoryInterests[categoryId] || 0) + watchedSeconds;
  state.currentVideoCategoryId = categoryId;
  if (video.channelId) {
    state.currentVideoChannelId = video.channelId;
  }

  pruneInterestTagsToLimit(1024);
}

function onVisibilityChange() {
  if (document.hidden) {
    finalizeWatchSession({ ended: false });
  }
}

function selectCategoryForQuickSwitch() {
  const categoryId = drawWeightedCategoryExcludingRecent();
  if (!categoryId) {
    return currentVideo?.categoryId || state.currentVideoCategoryId || defaultCategoryId();
  }

  recentSelectedCategories.push(categoryId);
  if (recentSelectedCategories.length > 10) {
    recentSelectedCategories.shift();
  }
  return categoryId;
}

function drawWeightedCategoryExcludingRecent() {
  const categoryEntries = Object.entries(state.categoryInterests)
    .filter(([, weight]) => Number.isFinite(weight) && weight > 0)
    .filter(([categoryId]) => !recentSelectedCategories.includes(categoryId));

  if (categoryEntries.length === 0) {
    const fallback = categoryCatalog
      .map((entry) => entry.id)
      .filter((categoryId) => !recentSelectedCategories.includes(categoryId));
    if (!fallback.length) {
      return "";
    }
    return fallback[Math.floor(Math.random() * fallback.length)];
  }

  return weightedPick(categoryEntries);
}

function weightedPick(entries) {
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (total <= 0) {
    return entries[Math.floor(Math.random() * entries.length)][0];
  }

  let cursor = Math.random() * total;
  for (const [key, weight] of entries) {
    cursor -= weight;
    if (cursor <= 0) {
      return key;
    }
  }

  return entries[entries.length - 1][0];
}

async function getCategoryPlayback(categoryId, options) {
  const list = await getCategorySearchResults(categoryId, options.forceRefresh);
  if (!list.length) {
    return null;
  }

  const cache = categorySearchCache.get(categoryId);
  if (!cache) {
    return null;
  }

  if (options.preferNext) {
    cache.index = (cache.index + 1) % list.length;
  } else if (cache.index < 0 || cache.index >= list.length) {
    cache.index = 0;
  }

  const video = list[cache.index];
  return ensurePlaybackForVideo(video, {
    creatorId: `${dynamicSearchCreatorId}-${categoryId}`,
    creatorName: `カテゴリ検索 ${categoryId}`,
    playlistId: `search-${categoryId}`,
    playlistTitle: `カテゴリ ${categoryId} 検索結果`,
    categoryId
  });
}

async function getCategorySearchResults(categoryId, forceRefresh) {
  const now = Date.now();
  const cache = categorySearchCache.get(categoryId);

  if (cache && !forceRefresh && cache.nextRefreshAt > now && cache.results.length) {
    cache.nextRefreshAt -= categorySearchShortenMs;
    return cache.results;
  }

  const sampledTags = weightedSampleTags(8);
  let results = await searchVideosByCategory(categoryId, sampledTags);

  if (!results.length && Object.keys(state.interestTags).length === 0) {
    results = await fetchMostPopularVideos(categoryId);
  }

  if (!results.length) {
    results = fallbackVideosByCategory(categoryId);
  }

  const nextRefreshAt = now + categorySearchRefreshMs;
  categorySearchCache.set(categoryId, {
    results,
    index: 0,
    nextRefreshAt
  });

  return results;
}

function weightedSampleTags(count) {
  const entries = Object.entries(state.interestTags).filter(([, weight]) => Number.isFinite(weight) && weight > 0);
  if (!entries.length) {
    return [];
  }

  const pool = entries.slice();
  const sampled = [];

  while (sampled.length < count && pool.length > 0) {
    const picked = weightedPick(pool);
    sampled.push(picked);
    const index = pool.findIndex(([tag]) => tag === picked);
    pool.splice(index, 1);
  }

  return sampled;
}

async function searchVideosByCategory(categoryId, tags) {
  if (!youtubeApiKey) {
    return [];
  }

  const query = tags.length ? tags.join(" OR ") : categoryLabel(categoryId);
  const params = new URLSearchParams({
    part: "snippet",
    type: "video",
    maxResults: "50",
    order: "relevance",
    q: query,
    videoCategoryId: categoryId,
    key: youtubeApiKey
  });

  try {
    const data = await fetchYouTubeApi(`https://www.googleapis.com/youtube/v3/search?${params}`);
    const items = data.items || [];
    const ids = items.map((item) => item.id?.videoId).filter(Boolean);
    const details = await fetchVideoDetails(ids);
    const detailMap = new Map(details.map((detail) => [detail.id, detail]));

    return items
      .map((item) => {
        const videoId = item.id?.videoId;
        if (!videoId) {
          return null;
        }

        const detail = detailMap.get(videoId);
        return createVideoEntryFromApiItem(item.snippet, detail, categoryId, tags);
      })
      .filter(Boolean);
  } catch (_error) {
    return [];
  }
}

async function fetchMostPopularVideos(categoryId) {
  if (!youtubeApiKey) {
    return [];
  }

  const params = new URLSearchParams({
    part: "snippet,contentDetails",
    chart: "mostPopular",
    maxResults: "50",
    videoCategoryId: categoryId,
    key: youtubeApiKey
  });

  try {
    const data = await fetchYouTubeApi(`https://www.googleapis.com/youtube/v3/videos?${params}`);
    return (data.items || []).map((item) => {
      const durationSeconds = parseIsoDurationToSeconds(item.contentDetails?.duration || "");
      return {
        id: item.id,
        title: item.snippet?.title || "",
        channel: item.snippet?.channelTitle || "",
        channelId: item.snippet?.channelId || "",
        publishedAt: item.snippet?.publishedAt || "",
        categoryId: item.snippet?.categoryId || categoryId,
        tags: sanitizeTags([...(item.snippet?.tags || []), item.snippet?.title || "", categoryLabel(categoryId)]),
        playlistTitle: "人気動画",
        durationSeconds
      };
    });
  } catch (_error) {
    return [];
  }
}

function fallbackVideosByCategory(categoryId) {
  return [];
}

async function fetchVideoDetails(videoIds) {
  if (!youtubeApiKey || !videoIds.length) {
    return [];
  }

  const params = new URLSearchParams({
    part: "snippet,contentDetails",
    id: videoIds.join(","),
    key: youtubeApiKey
  });

  try {
    const data = await fetchYouTubeApi(`https://www.googleapis.com/youtube/v3/videos?${params}`);
    return data.items || [];
  } catch (_error) {
    return [];
  }
}

function createVideoEntryFromApiItem(snippet, detail, fallbackCategoryId, sampledTags) {
  const videoId = detail?.id || "";
  if (!videoId) {
    return null;
  }

  const durationSeconds = parseIsoDurationToSeconds(detail?.contentDetails?.duration || "");
  const tags = sanitizeTags([
    ...(detail?.snippet?.tags || []),
    ...(sampledTags || []),
    snippet?.title || "",
    snippet?.channelTitle || ""
  ]);

  return {
    id: videoId,
    title: snippet?.title || detail?.snippet?.title || "",
    channel: snippet?.channelTitle || detail?.snippet?.channelTitle || "",
    channelId: snippet?.channelId || detail?.snippet?.channelId || "",
    publishedAt: snippet?.publishedAt || detail?.snippet?.publishedAt || "",
    categoryId: detail?.snippet?.categoryId || fallbackCategoryId,
    tags,
    playlistTitle: `カテゴリ ${detail?.snippet?.categoryId || fallbackCategoryId} 検索`,
    durationSeconds
  };
}

function categoryLabel(categoryId) {
  return categoryCatalog.find((entry) => entry.id === categoryId)?.label || "おすすめ";
}

function parseIsoDurationToSeconds(value) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value || "");
  if (!match) {
    return 0;
  }
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  return hours * 3600 + minutes * 60 + seconds;
}

function ensureCreator(creatorId, creatorName, categoryId, tags, channelId) {
  const existing = creatorMap.get(creatorId);
  if (existing) {
    return existing;
  }

  const creator = {
    id: creatorId,
    name: creatorName,
    channelId: channelId || "",
    defaultCategoryId: categoryId,
    defaultTags: sanitizeTags(tags),
    playlists: []
  };

  creatorList.push(creator);
  creatorMap.set(creatorId, creator);
  return creator;
}

function ensurePlaybackForVideo(video, context) {
  const creator = ensureCreator(
    context.creatorId,
    context.creatorName,
    context.categoryId,
    video.tags || [],
    video.channelId || ""
  );

  let playlist = playlistMap.get(context.playlistId);
  if (!playlist) {
    playlist = normalizePlaylist(
      creator,
      {
        id: context.playlistId,
        title: context.playlistTitle,
        popularity: 0,
        categoryId: context.categoryId,
        tags: video.tags || [],
        videos: []
      },
      context.categoryId,
      video.tags || []
    );
    creator.playlists.push(playlist);
    playlistMap.set(playlist.id, playlist);
  }

  const existingIndex = playlist.orderedVideos.findIndex((entry) => entry.id === video.id);
  if (existingIndex >= 0) {
    return { creatorId: creator.id, playlistId: playlist.id, videoIndex: existingIndex };
  }

  const normalizedVideo = {
    ...video,
    channel: video.channel || creator.name,
    channelId: video.channelId || creator.channelId || "",
    creatorId: creator.id,
    playlistId: playlist.id,
    playlistTitle: playlist.title,
    playbackIndex: playlist.orderedVideos.length,
    categoryId: video.categoryId || context.categoryId,
    tags: sanitizeTags(video.tags || []),
    durationSeconds: video.durationSeconds || 0
  };

  playlist.orderedVideos.push(normalizedVideo);
  videoMap.set(normalizedVideo.id, normalizedVideo);
  return {
    creatorId: creator.id,
    playlistId: playlist.id,
    videoIndex: normalizedVideo.playbackIndex
  };
}

async function getRelatedUploadsPlayback(video) {
  const channelId = video.channelId || state.currentVideoChannelId;
  if (!channelId || !youtubeApiKey) {
    return null;
  }

  try {
    const params = new URLSearchParams({ part: "contentDetails", id: channelId, key: youtubeApiKey });
    const channelData = await fetchYouTubeApi(`https://www.googleapis.com/youtube/v3/channels?${params}`);
    const uploadsId = channelData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsId) {
      return null;
    }

    const items = await fetchPlaylistItems(uploadsId);
    if (!items.length) {
      return null;
    }

    const randomItem = items[Math.floor(Math.random() * items.length)];
    const videoId = randomItem.snippet?.resourceId?.videoId;
    if (!videoId) {
      return null;
    }

    const details = await fetchVideoDetails([videoId]);
    const detail = details[0] || null;
    const entry = {
      id: videoId,
      title: randomItem.snippet?.title || detail?.snippet?.title || "",
      channel: randomItem.snippet?.channelTitle || detail?.snippet?.channelTitle || "",
      channelId: randomItem.snippet?.channelId || detail?.snippet?.channelId || channelId,
      publishedAt: randomItem.snippet?.publishedAt || detail?.snippet?.publishedAt || "",
      categoryId: detail?.snippet?.categoryId || video.categoryId || defaultCategoryId(),
      tags: sanitizeTags([...(detail?.snippet?.tags || []), randomItem.snippet?.title || ""]),
      playlistTitle: "関連アップロード",
      durationSeconds: parseIsoDurationToSeconds(detail?.contentDetails?.duration || "")
    };

    return ensurePlaybackForVideo(entry, {
      creatorId: `uploads-${channelId}`,
      creatorName: entry.channel || `channel-${channelId}`,
      playlistId: uploadsId,
      playlistTitle: "関連アップロード",
      categoryId: entry.categoryId
    });
  } catch (_error) {
    return null;
  }
}

async function ensureVideoMetadata(video) {
  if (!video || !youtubeApiKey) {
    return;
  }

  if (video.tags?.length && video.categoryId && video.channelId && video.durationSeconds > 0) {
    return;
  }

  const details = await fetchVideoDetails([video.id]);
  const detail = details[0];
  if (!detail?.snippet) {
    return;
  }

  video.channelId = video.channelId || detail.snippet.channelId || "";
  video.categoryId = video.categoryId || detail.snippet.categoryId || defaultCategoryId();
  video.tags = sanitizeTags([...(video.tags || []), ...(detail.snippet.tags || []), detail.snippet.title || ""]);
  video.durationSeconds = video.durationSeconds || parseIsoDurationToSeconds(detail.contentDetails?.duration || "");

  state.currentVideoCategoryId = video.categoryId;
  state.currentVideoChannelId = video.channelId;
  saveState();
}
