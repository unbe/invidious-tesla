/**
 * CanvasPlayerEngine for Invidious
 *
 * Renders MP4 video streams onto an HTML5 <canvas> element using the browser's
 * hardware-accelerated WebCodecs VideoDecoder API, synchronized to an HTMLAudioElement.
 * Completely eliminates any <video> tag in the DOM to bypass vehicle/browser restrictions in Drive mode.
 */
(function(global) {
    'use strict';

    class CanvasPlayerEngine {
        constructor(canvas, mediaClock) {
            this.canvas = canvas;
            this.ctx = canvas ? canvas.getContext('2d') : null;
            this.mediaClock = mediaClock; // HTMLAudioElement master clock

            this.decoder = null;
            this.mp4box = null;
            this.frameQueue = [];
            this.animFrameId = null;
            this.abortController = null;

            this.videoTrack = null;
            this.timescale = 1;
            this.duration = 0;
            this.isReady = false;
            this.isDestroyed = false;

            this.videoUrl = '';
            this.currentByteOffset = 0;
            this.totalBytes = null;
            this.chunkSize = 1024 * 1024; // 1 MB chunks
            this.isFetching = false;
            this.isSeeking = false;
            this.seekEpoch = 0;
            this.needsKeyframe = true;

            this.boundRenderLoop = this.renderLoop.bind(this);
            this.bindClockEvents();
        }

        bindClockEvents() {
            if (!this.mediaClock) return;
            this._onPlay = () => this.onPlay();
            this._onPause = () => this.onPause();
            this._onSeeking = () => this.onSeeking();
            this._onSeeked = () => this.onSeeked();
            this._onRateChange = () => this.onRateChange();

            this.mediaClock.addEventListener('play', this._onPlay);
            this.mediaClock.addEventListener('pause', this._onPause);
            this.mediaClock.addEventListener('seeking', this._onSeeking);
            this.mediaClock.addEventListener('seeked', this._onSeeked);
            this.mediaClock.addEventListener('ratechange', this._onRateChange);
        }

        unbindClockEvents() {
            if (!this.mediaClock) return;
            this.mediaClock.removeEventListener('play', this._onPlay);
            this.mediaClock.removeEventListener('pause', this._onPause);
            this.mediaClock.removeEventListener('seeking', this._onSeeking);
            this.mediaClock.removeEventListener('seeked', this._onSeeked);
            this.mediaClock.removeEventListener('ratechange', this._onRateChange);
        }

        extractCodecDescription() {
            if (!this.videoTrack || !this.mp4box) return null;
            const trak = this.mp4box.moov?.traks?.find(t => t.tkhd.track_id === this.videoTrack.id);
            if (!trak?.mdia?.minf?.stbl?.stsd?.entries?.length) return null;
            const entry = trak.mdia.minf.stbl.stsd.entries[0];
            const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
            if (!box) return null;

            try {
                const DS = (typeof DataStream !== 'undefined' ? DataStream : (typeof MP4Box !== 'undefined' ? MP4Box.DataStream : null));
                if (!DS) return null;
                const stream = new DS(undefined, 0, DS.BIG_ENDIAN);
                box.write(stream);
                const descLength = stream.position - 8;
                if (descLength <= 0) return null;
                return new Uint8Array(stream.buffer, 8, descLength);
            } catch (err) {
                console.warn('CanvasPlayer: Could not extract codec description:', err);
                return null;
            }
        }

        async initDecoder() {
            if (!this.videoTrack) return;

            const codecStr = this.videoTrack.codec;
            const config = {
                codec: codecStr,
                codedWidth: this.videoTrack.video.width,
                codedHeight: this.videoTrack.video.height
            };

            const desc = this.extractCodecDescription();
            if (desc) {
                config.description = desc;
            }

            try {
                const support = await VideoDecoder.isConfigSupported(config);
                if (!support.supported) {
                    console.error('CanvasPlayer: WebCodecs configuration unsupported:', config);
                    return;
                }
            } catch (e) {
                console.warn('CanvasPlayer: isConfigSupported failed:', e);
            }

            this.decoder = new VideoDecoder({
                output: frame => {
                    if (this.isDestroyed) {
                        frame.close();
                        return;
                    }
                    this.frameQueue.push(frame);
                    if (this.mediaClock && this.mediaClock.paused && this.frameQueue.length === 1) {
                        this.renderFrame();
                    }
                },
                error: err => {
                    console.error('CanvasPlayer: VideoDecoder error:', err);
                }
            });

            this.decoder.configure(config);
            this.needsKeyframe = true;
        }

        loadStream(videoUrl) {
            this.videoUrl = videoUrl;
            this.isDestroyed = false;
            this.isReady = false;
            this.currentByteOffset = 0;
            this.totalBytes = null;
            this.frameQueue = [];

            if (typeof MP4Box === 'undefined') {
                console.error('CanvasPlayer: MP4Box library is not loaded');
                return;
            }

            this.mp4box = MP4Box.createFile();
            this.mp4box.onError = err => console.error('MP4Box error:', err);

            this.mp4box.onReady = async info => {
                const track = info.videoTracks[0];
                if (!track) {
                    console.error('CanvasPlayer: No video track found in MP4');
                    return;
                }

                this.videoTrack = track;
                this.timescale = track.timescale;
                this.duration = track.duration / track.timescale;

                if (this.canvas) {
                    this.canvas.width = track.video.width;
                    this.canvas.height = track.video.height;
                }

                await this.initDecoder();

                this.mp4box.setExtractionOptions(this.videoTrack.id, null, {
                    nbSamples: 30
                });

                this.mp4box.onSamples = (trackId, ref, samples) => {
                    if (trackId !== this.videoTrack.id || this.isDestroyed) return;
                    this.enqueueSamples(samples);
                };

                this.mp4box.start();
                this.isReady = true;

                if (this.mediaClock && !this.mediaClock.paused) {
                    this.startRenderLoop();
                }
                this.bufferAhead();
            };

            this.fetchInitialMoov();
        }

        async fetchInitialMoov() {
            this.abortController = new AbortController();
            const chunkSize = 2 * 1024 * 1024; // 2 MB
            let offset = 0;
            while (!this.isReady && !this.isDestroyed) {
                try {
                    let endByte = offset + chunkSize - 1;
                    if (this.totalBytes !== null && endByte >= this.totalBytes) {
                        endByte = this.totalBytes - 1;
                    }
                    const res = await fetch(this.videoUrl, {
                        headers: { Range: `bytes=${offset}-${endByte}` },
                        signal: this.abortController.signal
                    });

                    const contentRange = res.headers.get('Content-Range');
                    if (contentRange && this.totalBytes === null) {
                        const match = contentRange.match(/\/(\d+)$/);
                        if (match) this.totalBytes = parseInt(match[1], 10);
                    }

                    if (!res.ok) break;

                    const buf = await res.arrayBuffer();
                    if (!buf.byteLength) break;
                    buf.fileStart = offset;
                    offset += buf.byteLength;
                    this.currentByteOffset = offset;

                    if (this.mp4box && !this.isDestroyed) {
                        this.mp4box.appendBuffer(buf);
                    }

                    if (this.totalBytes !== null && offset >= this.totalBytes) break;
                    await new Promise(r => setTimeout(r, 0));
                } catch (err) {
                    if (err.name !== 'AbortError') {
                        console.error('CanvasPlayer: Failed initial fetch:', err);
                    }
                    break;
                }
            }
        }

        async bufferAhead() {
            if (this.isFetching || this.isDestroyed || !this.isReady || this.isSeeking) return;

            // Cap queue length to prevent GPU RAM exhaustion (25 frames)
            if (this.frameQueue.length >= 25) return;

            const currentTime = this.mediaClock ? this.mediaClock.currentTime : 0;
            const bufferedAhead = (this.frameQueue.length > 0)
                ? (this.frameQueue[this.frameQueue.length - 1].timestamp / 1_000_000) - currentTime
                : 0;

            if (bufferedAhead >= 6) return;
            if (this.totalBytes !== null && this.currentByteOffset >= this.totalBytes) return;

            this.isFetching = true;
            const startByte = this.currentByteOffset;
            let endByte = startByte + this.chunkSize - 1;
            if (this.totalBytes !== null && endByte >= this.totalBytes) {
                endByte = this.totalBytes - 1;
            }

            try {
                const res = await fetch(this.videoUrl, {
                    headers: { Range: `bytes=${startByte}-${endByte}` },
                    signal: this.abortController ? this.abortController.signal : undefined
                });

                if (!res.ok) {
                    if (res.status === 416 || (res.status === 400 && startByte > 0)) {
                        this.totalBytes = startByte;
                        this.isFetching = false;
                        return;
                    }
                    throw new Error(`HTTP ${res.status}`);
                }

                const buf = await res.arrayBuffer();
                buf.fileStart = startByte;
                this.currentByteOffset = startByte + buf.byteLength;

                if (this.mp4box && !this.isDestroyed && !this.isSeeking) {
                    this.mp4box.appendBuffer(buf);
                }
            } catch (err) {
                if (err.name !== 'AbortError') {
                    console.error('CanvasPlayer: Chunk fetch error:', err);
                }
            } finally {
                this.isFetching = false;
            }
        }

        enqueueSamples(samples) {
            if (!this.decoder || this.decoder.state !== 'configured') return;

            for (const sample of samples) {
                if (this.needsKeyframe) {
                    if (!sample.is_sync) continue;
                    this.needsKeyframe = false;
                }

                const chunk = new EncodedVideoChunk({
                    type: sample.is_sync ? 'key' : 'delta',
                    timestamp: (sample.cts * 1_000_000) / this.timescale,
                    duration: (sample.duration * 1_000_000) / this.timescale,
                    data: sample.data
                });

                try {
                    this.decoder.decode(chunk);
                } catch (e) {
                    console.warn('CanvasPlayer: decode error:', e);
                }
            }
        }

        startRenderLoop() {
            if (this.animFrameId) return;
            this.animFrameId = requestAnimationFrame(this.boundRenderLoop);
        }

        stopRenderLoop() {
            if (this.animFrameId) {
                cancelAnimationFrame(this.animFrameId);
                this.animFrameId = null;
            }
        }

        renderLoop() {
            if (this.isDestroyed) return;
            this.renderFrame();
            this.bufferAhead();

            if (this.mediaClock && !this.mediaClock.paused) {
                this.animFrameId = requestAnimationFrame(this.boundRenderLoop);
            } else {
                this.animFrameId = null;
            }
        }

        renderFrame() {
            if (!this.ctx || !this.mediaClock || this.frameQueue.length === 0) return;

            const masterTimeUs = this.mediaClock.currentTime * 1_000_000;

            // 1. Drop stale preroll frames older than master clock (with 60ms tolerance)
            while (this.frameQueue.length > 0 && this.frameQueue[0].timestamp < masterTimeUs - 60_000) {
                if (this.frameQueue.length === 1 && (this.mediaClock.paused || this.isSeeking)) {
                    break;
                }
                const staleFrame = this.frameQueue.shift();
                staleFrame.close();
            }

            // 2. Render frame closest to current master clock
            if (this.frameQueue.length > 0) {
                const headFrame = this.frameQueue[0];
                const timeDiff = headFrame.timestamp - masterTimeUs;

                if (timeDiff >= -60_000 && timeDiff <= 50_000) {
                    try {
                        this.ctx.drawImage(headFrame, 0, 0, this.canvas.width, this.canvas.height);
                    } catch (e) {
                        console.warn("CanvasPlayer: drawImage error:", e);
                    }

                    if (this.frameQueue.length > 1 && this.frameQueue[1].timestamp <= masterTimeUs) {
                        const consumed = this.frameQueue.shift();
                        consumed.close();
                        try {
                            this.ctx.drawImage(this.frameQueue[0], 0, 0, this.canvas.width, this.canvas.height);
                        } catch {}
                    }
                } else if (this.mediaClock.paused && this.frameQueue.length === 1) {
                    try {
                        this.ctx.drawImage(headFrame, 0, 0, this.canvas.width, this.canvas.height);
                    } catch {}
                }
            }
        }

        onPlay() {
            this.startRenderLoop();
        }

        onPause() {
            this.stopRenderLoop();
        }

        onSeeking() {
            this.seekEpoch++;
            this.isSeeking = true;
            this.stopRenderLoop();
        }

        onSeeked() {
            const epoch = ++this.seekEpoch;
            this.isSeeking = true;
            this.needsKeyframe = true;

            if (this.abortController) {
                this.abortController.abort();
                this.abortController = new AbortController();
                this.isFetching = false;
            }

            this.clearFrameQueue();
            if (this.decoder) {
                try {
                    this.decoder.reset();
                    const desc = this.extractCodecDescription();
                    this.decoder.configure({
                        codec: this.videoTrack.codec,
                        codedWidth: this.videoTrack.video.width,
                        codedHeight: this.videoTrack.video.height,
                        description: desc || undefined
                    });
                } catch (err) {
                    console.warn('CanvasPlayer: decoder reset error:', err);
                }
            }

            if (epoch !== this.seekEpoch || this.isDestroyed) return;

            const targetTimeSeconds = this.mediaClock ? this.mediaClock.currentTime : 0;
            if (this.videoTrack && this.mp4box) {
                const trak = this.mp4box.getTrackById(this.videoTrack.id);
                const seekInfo = trak
                    ? this.mp4box.seekTrack(targetTimeSeconds, true, trak)
                    : this.mp4box.seek(targetTimeSeconds, true);
                if (seekInfo && typeof seekInfo.offset === 'number') {
                    this.currentByteOffset = seekInfo.offset;
                }
            }

            this.isSeeking = false;
            this.bufferAhead();
            this.renderFrame();
        }

        onRateChange() {}

        clearFrameQueue() {
            while (this.frameQueue.length > 0) {
                const f = this.frameQueue.shift();
                try { f.close(); } catch {}
            }
        }

        destroy() {
            this.isDestroyed = true;
            this.stopRenderLoop();
            this.unbindClockEvents();

            if (this.abortController) {
                this.abortController.abort();
                this.abortController = null;
            }

            this.clearFrameQueue();
            if (this.decoder) {
                try { this.decoder.close(); } catch {}
                this.decoder = null;
            }

            this.mp4box = null;
            this.ctx = null;
            this.canvas = null;
            this.mediaClock = null;
        }
    }

    global.CanvasPlayerEngine = CanvasPlayerEngine;
})(typeof window !== 'undefined' ? window : this);
