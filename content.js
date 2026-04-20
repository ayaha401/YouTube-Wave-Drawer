/**
 * YouTube Wave Draw - content.js
 *
 * RekordBox 風 3BAND WAVEFORM + 高速プリスキャン機能
 *
 * [プリスキャン]
 *   "全波形取得" ボタン押下 → ミュート 8x 速で全再生 → 補間 → 先頭に戻す。
 *   スキャン中にキャンセル可能。完了後は通常速度で再生可能。
 *
 * [通常モード]
 *   再生しながらリアルタイムに波形を蓄積する。
 */

'use strict';

/* ─── 周波数帯域の境界 (Hz) ─────────────────────────────── */
const FREQ_LOW_MAX = 300;
const FREQ_MID_MAX = 3000;

/* ─── 描画 / サンプリング定数 ──────────────────────────── */
const SAMPLES_PER_SEC  = 30;
const CANVAS_HEIGHT    = 96;
const SCAN_SPEED       = 16;         // プリスキャン再生速度
const CONTAINER_ID     = 'ywd-waveform-container';

const COLOR_HIGH = { played: 'rgba(240,240,255,0.95)', past: 'rgba(130,130,150,0.75)' };
const COLOR_MID  = { played: 'rgba(255,145,30,0.92)',  past: 'rgba(130,70,15,0.70)'  };
const COLOR_LOW  = { played: 'rgba(40,140,255,0.92)',  past: 'rgba(20,65,130,0.70)'  };

const COLOR_BG       = '#0a0a0a';
const COLOR_GRID     = '#1a1a1a';
const COLOR_EMPTY    = '#252525';
const COLOR_PLAYHEAD = '#ffffff';

// バー高さ = RMS * AMP_SCALE * (H/2) — 上限なし、大音→高い・静音→低い
const AMP_SCALE = 3.5;

// HotCue キー 0–9 の固有色
const MARKER_COLORS = [
  '#ff4455', '#ff8800', '#ffdd00', '#88ff00', '#00ffaa',
  '#00ccff', '#6655ff', '#ff44cc', '#ffffff', '#aaaaaa',
];

/* ─── メインクラス ─────────────────────────────────────── */
class YouTubeWaveDrawer {
  constructor() {
    this._video       = null;
    this._audioCtx    = null;
    this._analyser    = null;
    this._container   = null;
    this._canvas      = null;
    this._ctx2d       = null;
    this._label       = null;
    this._scanBtn     = null;
    this._progressBar = null;
    this._progressWrap = null;

    this._waveData    = null;
    this._sampleTimer = null;
    this._rafId       = null;
    this._resizeObs   = null;
    this._videoObs    = null;

    this._binLowEnd   = 0;
    this._binMidEnd   = 0;
    this._binTotal    = 0;

    // プリスキャン管理
    this._scanActive   = false;
    this._isScanPlay   = false;
    this._scanProgress = 0;
    this._savedState   = null;

    // HotCue マーカー管理  key: '1'–'8', value: 秒数
    this._markers         = {};
    this._onKeyDown       = null;

    // ループ機能  9=開始, 0=終了
    this._loopStart       = null;
    this._loopEnd         = null;
    this._onTimeUpdate    = null;
    this._toastTimer      = null;
    this._toastText       = '';
    this._markerCanvas    = null;
    this._markerCtx       = null;
    // 波形解析 On/Off — 初回は必ず Off、動画切り替え時は前の状態を引き継ぐ
    this._analysisEnabled = false;
    this._toggleBtn       = null;

    this._ready = false;
  }

  /* ── エントリポイント ─────────────────────────────── */
  start() {
    this._watchNavigation();
    this._tryInit();
  }

  /* ── SPA ナビゲーション検知 ───────────────────────── */
  _watchNavigation() {
    let lastUrl = location.href;
    new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        this._teardown();
        if (location.href.includes('/watch')) setTimeout(() => this._tryInit(), 1500);
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  /* ── 動画要素・再生準備を待つ ─────────────────────── */
  _tryInit() {
    if (!location.href.includes('/watch')) return;
    if (document.getElementById(CONTAINER_ID)) return;

    const deadline = Date.now() + 20_000;
    const check = () => {
      if (Date.now() > deadline) return;
      const video = document.querySelector('video');
      if (video && video.readyState >= 2 && video.duration > 0) { this._setup(video); return; }
      if (video && video.readyState < 1) {
        video.addEventListener('loadedmetadata', () => this._tryInit(), { once: true });
        return;
      }
      setTimeout(check, 600);
    };
    check();
  }

  /* ── 通常動画判定（生放送・ショート・10分以上は false） ── */
  _isRegularVideo() {
    if (location.href.includes('/shorts/')) return false;
    if (!this._video) return false;
    const dur = this._video.duration;
    return isFinite(dur) && dur > 0 && dur < 600;  // 600秒 = 10分未満のみ有効
  }

  /* ── 初期化 ───────────────────────────────────────── */
  _setup(video) {
    this._video = video;

    // 生放送・ショートでは波形解析を強制 Off にする
    if (!this._isRegularVideo()) this._analysisEnabled = false;

    this._waveData = new Array(
      isFinite(video.duration) ? Math.ceil(video.duration * SAMPLES_PER_SEC) : 0
    ).fill(null);

    this._buildUI();
    this._connectAudio();
    this._startSampling();
    this._startRendering();

    this._videoObs = new MutationObserver(() => {
      const newDur = this._video.duration;
      if (newDur && Math.abs(newDur - this._waveData.length / SAMPLES_PER_SEC) > 1) {
        this._teardown();
        setTimeout(() => this._tryInit(), 1000);
      }
    });
    this._videoObs.observe(video, { attributeFilter: ['src'] });

    // キーボードマーカー: capture: true で YouTube より先にイベントを受け取る
    this._onKeyDown = (e) => this._handleMarkerKey(e);
    document.addEventListener('keydown', this._onKeyDown, { capture: true });

    // ループ監視
    this._onTimeUpdate = () => this._enforceLoop();
    video.addEventListener('timeupdate', this._onTimeUpdate);

    this._ready = true;
  }

  /* ── マーカー: キー入力ハンドラ ──────────────────── */
  _handleMarkerKey(e) {
    // 入力欄フォーカス中は無視
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (!this._video) return;
    if (!this._analysisEnabled) return;  // Off 時はキー操作を無視

    // e.key は Shift 時に '!' 等になるため e.code で物理キーを判定する
    const digitMatch = e.code.match(/^Digit([0-9])$/);
    if (!digitMatch) return;

    // YouTube の 0–9 シーク動作を上書き
    e.preventDefault();
    e.stopPropagation();

    const key = digitMatch[1];  // '0'–'9'

    /* ── 9 / 0 はループ機能 ── */
    if (key === '9' || key === '0') {
      if (e.shiftKey) {
        if (key === '9') { this._loopStart = null; this._showToast('ループ開始点を解除'); }
        else             { this._loopEnd   = null; this._showToast('ループ終了点を解除'); }
      } else {
        const t = this._video.currentTime;
        if (key === '9') { this._loopStart = t; this._showToast(`ループ開始 → ${this._formatTime(t)}`); }
        else             { this._loopEnd   = t; this._showToast(`ループ終了 → ${this._formatTime(t)}`); }
      }
      return;
    }

    /* ── 1–8 は HotCue ── */
    if (e.shiftKey) {
      /* Shift + 数字: マーカー削除 */
      if (this._markers[key] != null) {
        delete this._markers[key];
        this._showToast(`マーカー ${key} を削除`);
      }
      return;
    }

    if (this._markers[key] == null) {
      /* 未設定 → 現在位置にセット */
      const t = this._video.currentTime;
      this._markers[key] = t;
      this._showToast(`[${key}] → ${this._formatTime(t)} にセット`);
    } else {
      /* 設定済み → ジャンプ＆再生 */
      this._video.currentTime = this._markers[key];
      if (this._video.paused) this._video.play();
      this._showToast(`[${key}] → ${this._formatTime(this._markers[key])}`);
    }
  }

  /* ── ループ強制（timeupdate から呼ばれる） ────────── */
  _enforceLoop() {
    if (this._scanActive) return;
    if (this._loopStart == null || this._loopEnd == null) return;
    if (this._loopEnd <= this._loopStart) return;
    if (!this._video || this._video.paused) return;

    if (this._video.currentTime >= this._loopEnd) {
      this._video.currentTime = this._loopStart;
    }
  }

  /* ── 波形解析 On/Off トグル ──────────────────────── */
  _toggleAnalysis() {
    if (!this._isRegularVideo()) {
      this._showToast('生放送・ショート動画では波形解析を使用できません');
      return;
    }
    this._analysisEnabled = !this._analysisEnabled;
    if (!this._analysisEnabled && this._scanActive) this._cancelPrescan();
    this._applyAnalysisState();
    this._showToast(`波形解析 ${this._analysisEnabled ? 'ON' : 'OFF'}`);
  }

  _applyAnalysisState() {
    const on      = this._analysisEnabled;
    const allowed = this._isRegularVideo();

    // ボタン: 通常動画 → ▶/▼ で切替 / 生放送・ショート → × で封じる
    if (this._toggleBtn) {
      if (!allowed) {
        this._toggleBtn.textContent = '✕ 波形解析';
        Object.assign(this._toggleBtn.style, {
          color: '#444', borderColor: '#333', cursor: 'not-allowed',
        });
      } else {
        this._toggleBtn.textContent = on ? '▼ 波形解析' : '▶ 波形解析';
        Object.assign(this._toggleBtn.style, {
          color:       on ? '#ffdd00' : '#666',
          borderColor: on ? '#886600' : '#444',
          cursor: 'pointer',
        });
      }
    }

    // Off 時に非表示にする要素
    const show = on ? '' : 'none';
    if (this._canvas)       this._canvas.style.display       = show;
    if (this._markerCanvas) this._markerCanvas.style.display  = show;
    if (this._label)        this._label.style.display         = show;
    if (this._scanBtn)      this._scanBtn.style.display       = show;
    // progressWrap はスキャン中のみ表示されるため Off 時は強制非表示
    if (this._progressWrap && !on) this._progressWrap.style.display = 'none';
  }

  /* ── トースト通知（波形パネル内に短時間表示） ─────── */
  _showToast(text) {
    this._toastText = text;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      this._toastText = '';
    }, 1800);
  }

  /* ── UI 構築 ──────────────────────────────────────── */
  _buildUI() {
    const container = document.createElement('div');
    container.id = CONTAINER_ID;
    Object.assign(container.style, {
      width: '100%', background: COLOR_BG,
      boxSizing: 'border-box', position: 'relative',
      fontFamily: "'Inter','Helvetica Neue',sans-serif",
    });
    this._container = container;

    /* ヘッダー */
    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '5px 12px 3px',
    });

    /* 左: トグル + タイトル + 凡例 */
    const left = document.createElement('div');
    Object.assign(left.style, { display: 'flex', alignItems: 'center', gap: '10px' });

    /* 波形解析トグルボタン（タイトルの左） */
    const toggleBtn = document.createElement('button');
    Object.assign(toggleBtn.style, {
      background: 'none', border: '1px solid #444', borderRadius: '3px',
      color: '#888', fontSize: '9px', padding: '1px 5px', cursor: 'pointer',
      fontFamily: 'inherit', letterSpacing: '0.05em', lineHeight: '1.4',
      transition: 'color 0.15s, border-color 0.15s',
    });
    toggleBtn.title = '波形解析 On/Off';
    toggleBtn.addEventListener('click', () => this._toggleAnalysis());
    this._toggleBtn = toggleBtn;
    left.appendChild(toggleBtn);

    const title = document.createElement('span');
    title.textContent = '3 BAND WAVEFORM';
    Object.assign(title.style, { color: '#666', fontSize: '10px', letterSpacing: '0.12em', fontWeight: '600' });
    left.appendChild(title);

    [{ label: 'HIGH', color: COLOR_HIGH.played },
     { label: 'MID',  color: COLOR_MID.played  },
     { label: 'LOW',  color: COLOR_LOW.played   }].forEach(({ label, color }) => {
      const item = document.createElement('span');
      Object.assign(item.style, { display: 'flex', alignItems: 'center', gap: '3px', fontSize: '9px', color: '#777', letterSpacing: '0.08em' });
      const dot = document.createElement('span');
      Object.assign(dot.style, { display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: color });
      item.appendChild(dot);
      item.appendChild(document.createTextNode(label));
      left.appendChild(item);
    });

    const hint = document.createElement('span');
    hint.textContent = 'HotCue: 1–8  /  Loop: 9・0';
    Object.assign(hint.style, {
      fontSize: '9px', color: '#777', letterSpacing: '0.08em',
      borderLeft: '1px solid #333', paddingLeft: '10px', marginLeft: '2px',
    });
    left.appendChild(hint);

    /* 右: 時刻 + スキャンボタン */
    const right = document.createElement('div');
    Object.assign(right.style, { display: 'flex', alignItems: 'center', gap: '10px' });

    this._label = document.createElement('span');
    this._label.textContent = '0:00 / ' + this._formatTime(this._video.duration);
    Object.assign(this._label.style, { color: '#666', fontSize: '10px', letterSpacing: '0.04em' });

    /* スキャンボタン */
    this._scanBtn = document.createElement('button');
    this._scanBtn.textContent = '全波形取得';
    Object.assign(this._scanBtn.style, {
      background: '#1e3a5f', color: '#7fc8ff', border: '1px solid #2a5080',
      borderRadius: '4px', padding: '2px 8px', fontSize: '10px', cursor: 'pointer',
      letterSpacing: '0.05em', fontFamily: 'inherit',
      transition: 'background 0.2s',
    });
    this._scanBtn.addEventListener('click', () => {
      if (this._scanActive) this._cancelPrescan();
      else this._startPrescan();
    });

    /* Spotify 検索ボタン（タイトルで検索ページを開くだけ） */
    const spotifySearchBtn = document.createElement('button');
    spotifySearchBtn.textContent = 'Spotify';
    Object.assign(spotifySearchBtn.style, {
      background: '#1a2e1a', color: '#1db954', border: '1px solid #1db95444',
      borderRadius: '4px', padding: '2px 8px', fontSize: '10px',
      cursor: 'pointer', fontFamily: 'inherit', fontWeight: '600',
      letterSpacing: '0.04em', transition: 'opacity 0.2s',
    });
    spotifySearchBtn.title = 'Spotify で検索';
    spotifySearchBtn.addEventListener('click', () => {
      const titleEl = document.querySelector(
        '#title h1 yt-formatted-string, ' +
        'h1.ytd-video-primary-info-renderer yt-formatted-string, ' +
        'ytd-video-primary-info-renderer h1 yt-formatted-string'
      );
      const title = titleEl?.textContent?.trim()
                  || document.title.replace(/\s*[-–]\s*YouTube\s*$/, '').trim();
      window.open(
        'https://open.spotify.com/search/' + encodeURIComponent(title),
        '_blank'
      );
    });
    this._spotifySearchBtn = spotifySearchBtn;

    right.appendChild(this._label);
    right.appendChild(this._scanBtn);
    right.appendChild(this._spotifySearchBtn);

    header.appendChild(left);
    header.appendChild(right);
    container.appendChild(header);

    /* プログレスバー（スキャン中のみ表示） */
    this._progressWrap = document.createElement('div');
    Object.assign(this._progressWrap.style, {
      width: '100%', height: '3px', background: '#1a1a1a', display: 'none',
    });
    this._progressBar = document.createElement('div');
    Object.assign(this._progressBar.style, {
      height: '100%', width: '0%', background: '#2a6aad',
      transition: 'width 0.3s ease',
    });
    this._progressWrap.appendChild(this._progressBar);
    container.appendChild(this._progressWrap);

    /* HotCue ストリップ（ヘッダーと波形の間） */
    const markerCanvas = document.createElement('canvas');
    markerCanvas.height = 18;
    Object.assign(markerCanvas.style, { display: 'block', width: '100%' });
    this._markerCanvas = markerCanvas;
    this._markerCtx    = markerCanvas.getContext('2d');
    container.appendChild(markerCanvas);

    /* 波形 Canvas */
    const canvas = document.createElement('canvas');
    canvas.height = CANVAS_HEIGHT;
    Object.assign(canvas.style, { display: 'block', width: '100%', cursor: 'crosshair' });
    canvas.title = 'クリックでシーク';
    this._canvas = canvas;
    this._ctx2d  = canvas.getContext('2d');
    container.appendChild(canvas);

    canvas.addEventListener('click', (e) => {
      if (this._scanActive) return;
      const rect  = canvas.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      this._video.currentTime = ratio * this._video.duration;
    });

    /* ホバーツールチップ */
    const tooltip = document.createElement('div');
    Object.assign(tooltip.style, {
      position: 'absolute', top: '26px',
      background: 'rgba(0,0,0,0.8)', color: '#fff',
      fontSize: '10px', padding: '2px 7px', borderRadius: '3px',
      pointerEvents: 'none', display: 'none', letterSpacing: '0.04em',
    });
    container.appendChild(tooltip);

    canvas.addEventListener('mousemove', (e) => {
      if (this._scanActive) return;
      const rect  = canvas.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      tooltip.textContent = this._formatTime(ratio * this._video.duration);
      tooltip.style.display = 'block';
      tooltip.style.left = `${e.clientX - rect.left + 10}px`;
    });
    canvas.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });

    this._resizeObs = new ResizeObserver(() => this._resizeCanvas());
    this._resizeObs.observe(container);

    const target =
      document.querySelector('#below') ||
      document.querySelector('#player-container') ||
      document.querySelector('ytd-player')?.parentElement;

    if (target) target.insertBefore(container, target.firstChild);
    else document.body.prepend(container);

    this._resizeCanvas();
    this._applyAnalysisState();  // 動画切り替え後も On/Off 状態を復元
  }

  _resizeCanvas() {
    if (!this._container) return;
    const w = this._container.clientWidth || 640;
    if (this._canvas)       this._canvas.width       = w;
    if (this._markerCanvas) this._markerCanvas.width  = w;
  }

  /* ── Web Audio API 接続 ───────────────────────────── */
  _connectAudio() {
    try {
      this._audioCtx = new AudioContext({ sampleRate: 44100 });
      this._analyser = this._audioCtx.createAnalyser();
      this._analyser.fftSize = 4096;
      this._analyser.smoothingTimeConstant = 0.25;  // 滑らかさと応答のバランス
      this._analyser.minDecibels = -80;
      this._analyser.maxDecibels = -10;

      const nyquist  = this._audioCtx.sampleRate / 2;
      const binHz    = nyquist / this._analyser.frequencyBinCount;
      this._binLowEnd = Math.floor(FREQ_LOW_MAX / binHz);
      this._binMidEnd = Math.floor(FREQ_MID_MAX / binHz);
      this._binTotal  = this._analyser.frequencyBinCount;

      let source;
      if (typeof this._video.captureStream === 'function') {
        source = this._audioCtx.createMediaStreamSource(this._video.captureStream());
        source.connect(this._analyser);
      } else {
        source = this._audioCtx.createMediaElementSource(this._video);
        source.connect(this._analyser);
        source.connect(this._audioCtx.destination);
      }

      const resume = () => { if (this._audioCtx?.state === 'suspended') this._audioCtx.resume(); };
      this._video.addEventListener('play', resume);
      document.addEventListener('click', resume, { once: true });
      resume();
    } catch (err) {
      console.warn('[YWD] Audio 接続失敗:', err);
    }
  }

  /* ── サンプリング（高さ=RMS振幅 / 色=周波数帯域割合） ── */
  _startSampling() {
    if (!this._analyser) return;

    // 時間領域バッファ（RMS 計算用・高さを決定）
    const timeData = new Uint8Array(this._analyser.fftSize);
    // 周波数領域バッファ（帯域割合計算用・色を決定）
    const freqData = new Uint8Array(this._analyser.frequencyBinCount);

    // 帯域内のピーク値 (0–255) を返す
    const bandPeak = (start, end) => {
      let peak = 0;
      for (let i = start; i <= end; i++) {
        if (freqData[i] > peak) peak = freqData[i];
      }
      return peak;
    };

    this._sampleTimer = setInterval(() => {
      if (!this._analysisEnabled) return;  // Off 時はサンプリングしない
      if (!this._video || this._video.paused || this._video.ended) return;
      if (!this._analyser) return;

      /* ── ① バーの高さ: 時間領域 RMS ── */
      this._analyser.getByteTimeDomainData(timeData);
      let sum = 0;
      for (let i = 0; i < timeData.length; i++) {
        const v = (timeData[i] - 128) / 128;
        sum += v * v;
      }
      const amp = Math.sqrt(sum / timeData.length);  // 0〜1

      /* ── ② バーの色: 帯域ごとのピーク比率 ── */
      this._analyser.getByteFrequencyData(freqData);
      const rawLow  = bandPeak(0,                   this._binLowEnd);
      const rawMid  = bandPeak(this._binLowEnd + 1, this._binMidEnd);
      const rawHigh = bandPeak(this._binMidEnd + 1, this._binTotal - 1);
      const rawSum  = rawLow + rawMid + rawHigh || 1;

      // 各帯域の「割合」（合計 = 1.0）
      const low  = rawLow  / rawSum;
      const mid  = rawMid  / rawSum;
      const high = rawHigh / rawSum;

      const idx = Math.floor(this._video.currentTime * SAMPLES_PER_SEC);
      if (idx >= 0 && idx < this._waveData.length) {
        this._waveData[idx] = { amp, low, mid, high };
      }
    }, 1000 / SAMPLES_PER_SEC);
  }

  /* ══════════════════════════════════════════════════
   *  プリスキャン
   * ══════════════════════════════════════════════════ */

  async _startPrescan() {
    if (this._scanActive || !this._video || !this._analyser) return;

    const video = this._video;

    /* 現在の状態を保存 */
    this._savedState = {
      muted:       video.muted,
      playbackRate: video.playbackRate,
      currentTime: video.currentTime,
      paused:      video.paused,
    };

    this._scanActive   = true;
    this._scanProgress = 0;

    /* ── UI を「スキャン中」に変更 ── */
    this._scanBtn.textContent = 'キャンセル';
    Object.assign(this._scanBtn.style, { background: '#3d1a1a', color: '#ff8080', borderColor: '#6b2222' });
    this._progressWrap.style.display = 'block';
    this._progressBar.style.width    = '0%';

    /* ── 動画をミュート・高速化 ── */
    video.muted        = true;
    video.playbackRate = SCAN_SPEED;
    video.currentTime  = 0;

    /* シーク完了を待ってから play() */
    await new Promise(resolve => {
      const onSeeked = () => { video.removeEventListener('seeked', onSeeked); resolve(); };
      video.addEventListener('seeked', onSeeked);
    });

    if (!this._scanActive) { this._finishPrescan(false); return; }

    this._isScanPlay = true;
    try {
      await video.play();
    } catch (e) {
      console.warn('[YWD] Prescan play() failed:', e);
      this._isScanPlay = false;
      this._finishPrescan(false);
      return;
    }
    this._isScanPlay = false;

    /* ── プログレス更新ループ ──
     * ended イベントを待つと YouTube の自動再生が発火して次の動画に進んでしまう。
     * そのため 97% 到達時点で video.pause() を呼び、ended を発生させずに終了する。
     * timeupdate は 150ms インターバルより高頻度に発火するため取りこぼしを防げる。
     */
    await new Promise(resolve => {
      let done = false;

      const finish = (reason) => {
        if (done) return;
        done = true;
        video.removeEventListener('timeupdate', onTimeUpdate);
        clearInterval(tick);
        resolve(reason);
      };

      // timeupdate で閾値を監視 → pause() してから終了
      const onTimeUpdate = () => {
        if (!this._scanActive || !video.duration) return;
        const progress = video.currentTime / video.duration;
        if (progress >= 0.97) {
          video.pause();   // ← ended 発火前に止める（自動再生を防ぐ）
          finish('completed');
        }
      };
      video.addEventListener('timeupdate', onTimeUpdate);

      // 150ms ごとに UI プログレスを更新
      const tick = setInterval(() => {
        if (!this._scanActive) { finish('cancelled'); return; }
        if (!this._video)      { finish('error');     return; }
        const progress = video.duration > 0 ? video.currentTime / video.duration : 0;
        this._scanProgress = Math.min(progress, 0.97);
        this._progressBar.style.width = `${Math.round(this._scanProgress * 100)}%`;
      }, 150);
    });

    this._finishPrescan(this._scanActive); // scanActive=true なら正常完了
  }

  _cancelPrescan() {
    this._scanActive = false;
    // _startPrescan の await ループが次の tick で cancelled を検知して finishPrescan を呼ぶ
  }

  _finishPrescan(completed) {
    this._scanActive = false;
    const video = this._video;

    if (video && this._savedState) {
      /* ─ 動画を先頭に戻して元の状態を復元 ─ */
      video.pause();
      video.playbackRate = this._savedState.playbackRate;
      video.muted        = this._savedState.muted;
      video.currentTime  = 0;
      this._savedState   = null;
    }

    /* 欠損データを補間 */
    if (completed) this._interpolate();

    /* UI を元に戻す */
    if (this._scanBtn) {
      this._scanBtn.textContent = completed ? 'スキャン完了 ✓' : '全波形取得';
      Object.assign(this._scanBtn.style, {
        background: completed ? '#1a3d1a' : '#1e3a5f',
        color:      completed ? '#80ff80' : '#7fc8ff',
        borderColor: completed ? '#2a6b2a' : '#2a5080',
        cursor: completed ? 'default' : 'pointer',
      });
      if (completed) this._scanBtn.onclick = null;
    }
    if (this._progressBar) this._progressBar.style.width = completed ? '100%' : this._progressBar.style.width;
    setTimeout(() => {
      if (this._progressWrap) this._progressWrap.style.display = 'none';
    }, completed ? 800 : 0);
  }

  /* 欠損サンプルを隣接値で線形補間 */
  _interpolate() {
    const data = this._waveData;
    const len  = data.length;

    for (let i = 0; i < len; i++) {
      if (data[i] !== null) continue;

      /* 前後の非 null インデックスを探す */
      let prev = i - 1;
      while (prev >= 0 && data[prev] === null) prev--;
      let next = i + 1;
      while (next < len && data[next] === null) next++;

      if (prev < 0 && next >= len) continue;

      if (prev < 0) {
        data[i] = { ...data[next] };
      } else if (next >= len) {
        data[i] = { ...data[prev] };
      } else {
        const t = (i - prev) / (next - prev);
        const p = data[prev], n = data[next];
        data[i] = {
          amp:  p.amp  + (n.amp  - p.amp)  * t,
          low:  p.low  + (n.low  - p.low)  * t,
          mid:  p.mid  + (n.mid  - p.mid)  * t,
          high: p.high + (n.high - p.high) * t,
        };
      }
    }
  }

  /* ── Canvas 描画ループ ───────────────────────────── */
  _startRendering() {
    const loop = () => { this._rafId = requestAnimationFrame(loop); this._draw(); };
    loop();
  }

  _draw() {
    if (!this._analysisEnabled) return;   // Off 時は描画しない
    const canvas = this._canvas;
    const ctx    = this._ctx2d;
    if (!canvas || !ctx || !this._video) return;

    const W        = canvas.width;
    const H        = canvas.height;
    const total    = this._waveData.length;
    const duration = this._video.duration;
    const cy       = H / 2;

    if (total === 0 || W === 0) return;

    /* 背景 */
    ctx.fillStyle = COLOR_BG;
    ctx.fillRect(0, 0, W, H);

    /* グリッド */
    const gridStep = duration > 600 ? 60 : duration > 120 ? 30 : 10;
    ctx.strokeStyle = COLOR_GRID;
    ctx.lineWidth   = 1;
    for (let t = 0; t <= duration; t += gridStep) {
      const x = Math.round((t / duration) * W) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }

    /* 中心線 */
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(W, cy); ctx.stroke();

    /* 波形バー */
    const curIdx = Math.floor(this._video.currentTime * SAMPLES_PER_SEC);
    const barW   = W / total;
    const bw     = Math.max(barW - 0.4, 0.4);

    for (let i = 0; i < total; i++) {
      const sample = this._waveData[i];
      const x      = i * barW;
      const isPast = i <= curIdx;

      if (sample === null) {
        /* スキャン中はプログレスハイライト */
        if (this._scanActive && i <= Math.floor(this._scanProgress * total)) {
          ctx.fillStyle = '#1a3050';
        } else {
          ctx.fillStyle = COLOR_EMPTY;
        }
        ctx.fillRect(x, cy - 1, bw, 2);
        continue;
      }

      /* ──────────────────────────────────────────────────
       * バー高さ = RMS (amp) × AMP_SCALE × cy  ← 上限なし、自然な振れ幅
       * バー内色 = LOW/MID/HIGH の割合で塗り分け（合計 = halfH）
       * 中心から外側へ: LOW(青)→MID(橙)→HIGH(白)
       * ────────────────────────────────────────────────── */
      const halfH = sample.amp * AMP_SCALE * cy;  // 中心からの半分高さ
      const lowH  = Math.max(1, halfH * sample.low);
      const midH  = Math.max(1, halfH * sample.mid);
      const highH = Math.max(1, halfH * sample.high);

      const cLow  = isPast ? COLOR_LOW.played  : COLOR_LOW.past;
      const cMid  = isPast ? COLOR_MID.played  : COLOR_MID.past;
      const cHigh = isPast ? COLOR_HIGH.played : COLOR_HIGH.past;

      // LOW: 中心に最も近い（ベース）
      ctx.fillStyle = cLow;
      ctx.fillRect(x, cy - lowH, bw, lowH * 2);

      // MID: LOW の外側
      ctx.fillStyle = cMid;
      ctx.fillRect(x, cy - lowH - midH, bw, midH);
      ctx.fillRect(x, cy + lowH,        bw, midH);

      // HIGH: 最外層
      ctx.fillStyle = cHigh;
      ctx.fillRect(x, cy - lowH - midH - highH, bw, highH);
      ctx.fillRect(x, cy + lowH + midH,         bw, highH);
    }

    /* スキャン中オーバーレイ: 未スキャン領域を暗く */
    if (this._scanActive) {
      const scannedX = Math.round(this._scanProgress * W);
      ctx.fillStyle  = 'rgba(0,0,0,0.55)';
      ctx.fillRect(scannedX, 0, W - scannedX, H);

      /* スキャンヘッドライン */
      ctx.strokeStyle = '#4499cc';
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      ctx.moveTo(scannedX + 0.5, 0);
      ctx.lineTo(scannedX + 0.5, H);
      ctx.stroke();

      /* スキャン中テキスト */
      const pct = Math.round(this._scanProgress * 100);
      ctx.fillStyle = 'rgba(68,153,204,0.9)';
      ctx.font      = 'bold 11px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`スキャン中… ${pct}%`, scannedX + 6, 14);
      ctx.textAlign = 'start';
    }

    /* ── ループ領域オーバーレイ ── */
    if (this._analysisEnabled && !this._scanActive && duration > 0 &&
        this._loopStart != null && this._loopEnd != null && this._loopEnd > this._loopStart) {
      const lx1 = Math.round((this._loopStart / duration) * W);
      const lx2 = Math.round((this._loopEnd   / duration) * W);
      // 半透明オレンジ塗りつぶし
      ctx.fillStyle = 'rgba(255,140,0,0.13)';
      ctx.fillRect(lx1, 0, lx2 - lx1, H);
      // 開始・終了の縦線
      ctx.strokeStyle = 'rgba(255,160,40,0.85)';
      ctx.lineWidth   = 1.5;
      ctx.beginPath(); ctx.moveTo(lx1 + 0.5, 0); ctx.lineTo(lx1 + 0.5, H); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(lx2 + 0.5, 0); ctx.lineTo(lx2 + 0.5, H); ctx.stroke();
    }

    /* ── 波形上のマーカーライン（縦線のみ・HotCue On 時のみ） ── */
    if (this._analysisEnabled && !this._scanActive && duration > 0) {
      Object.entries(this._markers).forEach(([key, time]) => {
        if (time == null) return;
        const mx    = Math.round((time / duration) * W);
        const color = MARKER_COLORS[parseInt(key)];
        ctx.strokeStyle = color;
        ctx.lineWidth   = 1.5;
        ctx.beginPath();
        ctx.moveTo(mx + 0.5, 0);
        ctx.lineTo(mx + 0.5, H);
        ctx.stroke();
      });
    }

    /* ── HotCue ストリップ描画（HotCue 正方形 + ループ三角形） ── */
    if (this._markerCanvas && this._markerCtx && duration > 0) {
      const mc = this._markerCtx;
      const mW = this._markerCanvas.width;
      const mH = this._markerCanvas.height;

      mc.fillStyle = '#111111';
      mc.fillRect(0, 0, mW, mH);

      /* ループ領域の帯（両マーカーが揃っているとき） */
      if (this._loopStart != null && this._loopEnd != null && this._loopEnd > this._loopStart) {
        const lx1 = Math.round((this._loopStart / duration) * mW);
        const lx2 = Math.round((this._loopEnd   / duration) * mW);
        mc.fillStyle = 'rgba(255,140,0,0.18)';
        mc.fillRect(lx1, 0, lx2 - lx1, mH);
      }

      /* ループマーカー（オレンジ下三角） */
      const drawLoopTriangle = (time) => {
        if (time == null) return;
        const mx  = Math.round((time / duration) * mW);
        const TW  = 10;  // 三角の底辺幅
        const TH  = 10;  // 三角の高さ
        const ty  = 1;   // 上端 Y
        mc.fillStyle = 'rgba(255,150,30,0.95)';
        mc.beginPath();
        mc.moveTo(mx - TW / 2, ty);
        mc.lineTo(mx + TW / 2, ty);
        mc.lineTo(mx,          ty + TH);
        mc.closePath();
        mc.fill();
      };
      drawLoopTriangle(this._loopStart);
      drawLoopTriangle(this._loopEnd);

      const SQ = 14;  // HotCue 正方形のサイズ (px)

      Object.entries(this._markers).forEach(([key, time]) => {
        if (time == null) return;
        const mx    = Math.round((time / duration) * mW);
        const color = MARKER_COLORS[parseInt(key)];

        // 正方形（中心が縦線と一致）
        const sqX = mx - SQ / 2;
        const sqY = mH - SQ - 1;
        mc.fillStyle = color;
        mc.fillRect(sqX, sqY, SQ, SQ);

        // 数字を白文字でド真ん中に
        mc.fillStyle    = '#ffffff';
        mc.font         = 'bold 10px sans-serif';
        mc.textAlign    = 'center';
        mc.textBaseline = 'middle';
        mc.fillText(key, mx, sqY + SQ / 2);
      });
      mc.textAlign    = 'start';
      mc.textBaseline = 'alphabetic';
    }

    /* 再生ヘッド */
    if (!this._scanActive) {
      const ratio = duration > 0 ? this._video.currentTime / duration : 0;
      const px    = Math.round(ratio * W);
      ctx.strokeStyle = COLOR_PLAYHEAD;
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      ctx.moveTo(px + 0.5, 0); ctx.lineTo(px + 0.5, H); ctx.stroke();
    }

    /* ── トースト通知 ── */
    if (this._toastText) {
      const pad = 8;
      ctx.font = 'bold 11px sans-serif';
      const tw = ctx.measureText(this._toastText).width + pad * 2;
      const tx = (W - tw) / 2;
      const ty = cy - 14;
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.beginPath();
      ctx.roundRect(tx, ty, tw, 22, 4);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.fillText(this._toastText, W / 2, ty + 15);
      ctx.textAlign = 'start';
    }

    /* 時刻ラベル */
    if (this._label) {
      this._label.textContent = this._scanActive
        ? `スキャン中 ${Math.round(this._scanProgress * 100)}%`
        : `${this._formatTime(this._video.currentTime)} / ${this._formatTime(duration)}`;
    }
  }

  /* ── ユーティリティ ───────────────────────────────── */
  _formatTime(sec) {
    if (!isFinite(sec)) return '0:00';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return h > 0
      ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
      : `${m}:${String(s).padStart(2,'0')}`;
  }

  /* ── クリーンアップ ───────────────────────────────── */
  _teardown() {
    this._scanActive = false;

    if (this._savedState && this._video) {
      this._video.muted        = this._savedState.muted;
      this._video.playbackRate = this._savedState.playbackRate;
      this._savedState = null;
    }

    if (this._onKeyDown) {
      document.removeEventListener('keydown', this._onKeyDown, { capture: true });
      this._onKeyDown = null;
    }
    if (this._onTimeUpdate && this._video) {
      this._video.removeEventListener('timeupdate', this._onTimeUpdate);
      this._onTimeUpdate = null;
    }
    if (this._toastTimer)  { clearTimeout(this._toastTimer);     this._toastTimer = null; }
    this._markers   = {};
    this._loopStart = null;
    this._loopEnd   = null;
    this._toastText = '';

    if (this._rafId)       { cancelAnimationFrame(this._rafId);  this._rafId = null; }
    if (this._sampleTimer) { clearInterval(this._sampleTimer);   this._sampleTimer = null; }
    if (this._resizeObs)   { this._resizeObs.disconnect();       this._resizeObs = null; }
    if (this._videoObs)    { this._videoObs.disconnect();        this._videoObs = null; }
    if (this._audioCtx)    { this._audioCtx.close();             this._audioCtx = null; }

    const el = document.getElementById(CONTAINER_ID);
    if (el) el.remove();

    this._video = this._analyser = this._canvas = this._ctx2d =
    this._container = this._label = this._waveData =
    this._scanBtn = this._progressBar = this._progressWrap = null;
    this._ready = false;
  }
}

/* ─── 起動 ─────────────────────────────────────────────── */
const drawer = new YouTubeWaveDrawer();
drawer.start();
