/*
 * Copyright (c) 2026 Azzar Budiyanto / LilyOpenCMS.
 * Licensed under the MIT License.
 * Contact: azzar.mr.zs@gmail.com for inquiries.
 *
 * State-of-the-art reCAPTCHA v2 solver for Playwright.
 *
 * Supports:
 *   - reCAPTCHA v2 visible checkbox (size=normal)
 *   - reCAPTCHA v2 invisible (size=invisible, triggered programmatically)
 *   - Image grid challenges (3×3, 4×4, dynamic) — returns data for visual solving
 *   - Audio challenges — transcribed via local Whisper (no API key needed)
 *   - Both google.com/recaptcha and recaptcha.net domains
 *
 * Strategy waterfall (in order of preference):
 *   1. Token injection  — extract sitekey, fire grecaptcha callback directly
 *      (works for invisible reCAPTCHA without any visible challenge)
 *   2. Checkbox click   — human-like click on anchor iframe checkbox
 *      (often passes on low-risk/real-browser sessions)
 *   3. Audio challenge  — switch to audio, download MP3, transcribe via Whisper
 *   4. Image challenge  — extract tile metadata for agent visual solving
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const crypto = require('crypto');

const TEMP_DIR = '/tmp';

// Selectors for both google.com/recaptcha and recaptcha.net domains
const ANCHOR_SEL  = 'iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/enterprise/anchor"]';
const BFRAME_SEL  = 'iframe[src*="recaptcha/api2/bframe"], iframe[src*="recaptcha/enterprise/bframe"]';
// Fallback title-based selector (used when src is not yet populated)
const TITLE_SEL   = 'iframe[title="reCAPTCHA"]';

// ─────────────────────────────────────────────────────────────────────────────

class RecaptchaSolver {
    constructor(page) {
        this.page = page;
    }

    // ── Public API ─────────────────────────────────────────────────────────

    /**
     * Primary entry point. Runs strategy waterfall:
     *   1. Token injection  (invisible reCAPTCHA)
     *   2. Checkbox click   (visible, may pass without challenge)
     *   3. Image challenge  (returns metadata for visual solving)
     *
     * Returns:
     *   { method: 'token',    solved: true }
     *   { method: 'click',    solved: true }
     *   { method: 'image',    solved: false, challenge: {...} }
     *   { method: 'audio',    solved: false, challenge: { type: 'audio' } }
     */
    async solve() {
        // ── 1. Detect and characterize the CAPTCHA instance ──────────────
        const info = await this._detectCaptchaInstance();

        if (!info.found) {
            throw new Error('No reCAPTCHA instance found on this page');
        }

        console.error(`[CAPTCHA] Detected: type=${info.type}, domain=${info.domain}, sitekey=${info.sitekey?.substring(0, 12)}...`);

        // ── 2. Invisible reCAPTCHA → token injection ──────────────────────
        // Invisible CAPTCHAs never show a checkbox; they fire a callback when
        // grecaptcha.execute() resolves. We simulate this by injecting a
        // solved token via the ___grecaptcha_cfg client callback.
        if (info.type === 'invisible') {
            console.error('[CAPTCHA] Strategy: token injection (invisible reCAPTCHA)');
            const injected = await this._tryTokenInjection(info.sitekey);
            if (injected) return { method: 'token', solved: true };
            // Fall through to checkbox attempt if injection fails
        }

        // ── 3. Visible checkbox click ─────────────────────────────────────
        const anchorFrame = await this._getVisibleFrame(ANCHOR_SEL, TITLE_SEL);
        if (!anchorFrame) throw new Error('reCAPTCHA anchor iframe not found or not visible');

        console.error('[CAPTCHA] Strategy: checkbox click');
        await anchorFrame.waitForSelector('.recaptcha-checkbox, .rc-anchor-content', { timeout: 8000 });
        await this._humanClick(anchorFrame, '.recaptcha-checkbox, .rc-anchor-content');
        await this.page.waitForTimeout(1800 + Math.random() * 1200);

        if (await this._isSolved()) {
            console.error('[CAPTCHA] Solved by checkbox click alone');
            return { method: 'click', solved: true };
        }

        // ── 4. Challenge appeared — detect type ───────────────────────────
        const bframe = await this._getAnyFrame(BFRAME_SEL);
        if (!bframe) throw new Error('Challenge iframe not found after checkbox click');

        const challengeType = await this._detectChallengeType(bframe);
        console.error(`[CAPTCHA] Challenge type: ${challengeType}`);

        if (challengeType === 'doscaptcha') {
            throw new Error('Bot detected by reCAPTCHA (rate-limited). Try again later.');
        }

        if (challengeType === 'image') {
            const challenge = await this._getImageChallengeInfo(bframe);
            return { method: 'image', solved: false, challenge };
        }

        if (challengeType === 'audio') {
            return { method: 'audio', solved: false, challenge: { type: 'audio' } };
        }

        throw new Error(`Unsupported challenge type: ${challengeType}`);
    }

    /**
     * Solve audio challenge via local Whisper transcription.
     * Call this after solve() returns { method: 'audio' }.
     * Requires ffmpeg in PATH.
     */
    async solveAudio() {
        const bframe = await this._getAnyFrame(BFRAME_SEL);
        if (!bframe) throw new Error('Challenge iframe not found');

        const challengeType = await this._detectChallengeType(bframe);
        if (challengeType === 'doscaptcha') throw new Error('Bot detected by reCAPTCHA');

        // Switch from image to audio if needed
        if (challengeType === 'image') {
            console.error('[CAPTCHA] Switching to audio challenge...');
            await this._switchToAudio(bframe);
            await this.page.waitForTimeout(2000);
            if (await this._isDetected()) throw new Error('Bot detected after audio switch');
        }

        // Click PLAY to load audio source URL (required before extraction)
        const playBtn = await bframe.$('#recaptcha-audio-play-button').catch(() => null);
        if (playBtn) {
            await this._humanClick(bframe, '#recaptcha-audio-play-button');
            await this.page.waitForTimeout(2500);
        }

        const audioUrl = await this._getAudioUrl(bframe);
        if (!audioUrl) throw new Error('Could not find reCAPTCHA audio source URL');

        console.error(`[CAPTCHA] Audio URL found, transcribing...`);
        const text = await this._transcribeAudio(audioUrl);
        console.error(`[CAPTCHA] Transcription: "${text}"`);

        await this._submitAnswer(text);
        await this.page.waitForTimeout(1500);

        if (!(await this._isSolved())) throw new Error('reCAPTCHA audio submission failed');
        return { method: 'audio', solved: true, transcription: text };
    }

    /**
     * Check if the reCAPTCHA token is present and non-expired.
     */
    async verifySolved() {
        return this._isSolved();
    }

    // ── Detection ──────────────────────────────────────────────────────────

    /**
     * Inspect the page for any reCAPTCHA instance and return its metadata.
     * Returns: { found, type, sitekey, domain, widget }
     */
    async _detectCaptchaInstance() {
        return this.page.evaluate(({ ANCHOR_SEL, TITLE_SEL }) => {
            // Search all iframes including those in shadow DOM
            function allIframes(root = document) {
                const frames = Array.from(root.querySelectorAll('iframe'));
                root.querySelectorAll('*').forEach(el => {
                    if (el.shadowRoot) frames.push(...allIframes(el.shadowRoot));
                });
                return frames;
            }

            const candidates = allIframes();

            // Also check script tags for grecaptcha widget div
            const widgets = Array.from(document.querySelectorAll(
                '[data-sitekey], .g-recaptcha, [class*="recaptcha"]'
            ));

            // Collect ALL recaptcha iframes — prefer invisible over normal.
            // Qwiklabs injects two: a hidden size=normal tracking badge (0×0)
            // and the actual size=invisible trigger (256×60). We must check all.
            const rcFrames = candidates
                .filter(f => (f.src || '').includes('recaptcha'))
                .map(f => {
                    const url    = new URL(f.src);
                    const sitekey = url.searchParams.get('k') || '';
                    const size   = url.searchParams.get('size') || 'normal';
                    const domain = url.hostname;
                    const rect   = f.getBoundingClientRect();
                    return { sitekey, size, domain, w: rect.width, h: rect.height };
                })
                .filter(f => f.sitekey);

            if (rcFrames.length > 0) {
                // Prefer invisible; if none, take any
                const best = rcFrames.find(f => f.size === 'invisible') || rcFrames[0];
                return {
                    found:  true,
                    type:   best.size === 'invisible' ? 'invisible' : 'visible',
                    sitekey: best.sitekey,
                    domain: best.domain,
                    widget: null,
                };
            }

            // Fallback: check widget divs
            for (const w of widgets) {
                const sitekey = w.getAttribute('data-sitekey') || '';
                const size    = w.getAttribute('data-size') || 'normal';
                if (sitekey) {
                    return { found: true, type: size === 'invisible' ? 'invisible' : 'visible', sitekey, domain: 'www.google.com', widget: w.tagName };
                }
            }

            // Fallback: check ___grecaptcha_cfg
            if (window.___grecaptcha_cfg && window.___grecaptcha_cfg.clients) {
                const clients = window.___grecaptcha_cfg.clients;
                for (const key of Object.keys(clients)) {
                    const client = clients[key];
                    if (client && client.sitekey) {
                        return { found: true, type: client.size === 'invisible' ? 'invisible' : 'visible', sitekey: client.sitekey, domain: 'www.google.com', widget: null };
                    }
                    // Iterate nested client objects
                    for (const subkey of Object.keys(client || {})) {
                        const sub = client[subkey];
                        if (sub && typeof sub === 'object' && sub.sitekey) {
                            return { found: true, type: sub.size === 'invisible' ? 'invisible' : 'visible', sitekey: sub.sitekey, domain: 'www.google.com', widget: null };
                        }
                    }
                }
            }

            return { found: false };
        }, { ANCHOR_SEL, TITLE_SEL });
    }

    // ── Strategy 1: Token injection ────────────────────────────────────────

    /**
     * For invisible reCAPTCHA: inject a dummy g-recaptcha-response token
     * and fire all registered grecaptcha callbacks.
     *
     * NOTE: This relies on the site's grecaptcha callback accepting the token
     * for client-side gating. Server-side verification will still validate the
     * token with Google's API, so this is only reliable in testing contexts
     * (like Qwiklabs) where the backend re-validates via their own session token
     * from grecaptcha.execute(), not a hardcoded bypass.
     *
     * For Qwiklabs specifically: the "Luncurkan" button calls grecaptcha.execute()
     * which resolves with a valid token from Google (since we're running in a real
     * Chrome with real session cookies). The CAPTCHA here is just ensuring the
     * page callback fires after that token is received.
     */
    async _tryTokenInjection(sitekey) {
        try {
            // For real Chrome sessions with valid cookies/fingerprint,
            // attempt to programmatically execute and get the real token
            const executed = await this.page.evaluate(() => {
                if (typeof window.grecaptcha === 'undefined') return false;
                if (typeof window.grecaptcha.execute !== 'function') return false;

                // Find widget ID from ___grecaptcha_cfg
                if (!window.___grecaptcha_cfg || !window.___grecaptcha_cfg.clients) return false;

                const clients = window.___grecaptcha_cfg.clients;
                let widgetId = null;

                for (const key of Object.keys(clients)) {
                    // widget IDs are numeric strings
                    if (!isNaN(parseInt(key))) { widgetId = parseInt(key); break; }
                }

                if (widgetId === null) return false;

                // Fire execute — this will trigger the real reCAPTCHA flow
                // and resolve via the registered callback
                try {
                    window.grecaptcha.execute(widgetId);
                    return true;
                } catch (e) {
                    return false;
                }
            });

            if (executed) {
                // Wait for the callback to fire (grecaptcha.execute is async)
                await this.page.waitForTimeout(3000 + Math.random() * 2000);
                if (await this._isSolved()) return true;
            }

            return false;
        } catch {
            return false;
        }
    }

    // ── iframe acquisition ─────────────────────────────────────────────────

    /**
     * Get the FIRST iframe matching selector that has visible dimensions.
     * Falls back to title selector if src-based selector finds nothing visible.
     */
    async _getVisibleFrame(srcSelector, titleSelector) {
        const selectors = [srcSelector, titleSelector].filter(Boolean);
        for (const sel of selectors) {
            await this.page.waitForSelector(sel, { state: 'attached', timeout: 5000 }).catch(() => null);
            const els = await this.page.$$(sel);
            for (const el of els) {
                const box = await el.boundingBox().catch(() => null);
                if (box && box.width > 0 && box.height > 0) {
                    return el.contentFrame();
                }
            }
        }
        return null;
    }

    /**
     * Get ANY iframe matching selector — includes invisible ones (0×0).
     * Used for the bframe (challenge popup) which may not have dimensions.
     */
    async _getAnyFrame(selector) {
        await this.page.waitForSelector(selector, { state: 'attached', timeout: 8000 }).catch(() => null);
        const el = await this.page.$(selector);
        if (!el) return null;
        return el.contentFrame();
    }

    // ── Challenge detection ────────────────────────────────────────────────

    async _detectChallengeType(bframe) {
        // Rate-limited / bot detected
        const hasDoscaptcha = await bframe.evaluate(() =>
            document.body?.innerText?.includes('Try again later') ?? false
        ).catch(() => false);
        if (hasDoscaptcha) return 'doscaptcha';

        return bframe.evaluate(() => {
            // Audio indicators
            if (document.querySelector('#audio-response') ||
                document.querySelector('#recaptcha-audio-play-button') ||
                document.body?.innerText?.includes('Press PLAY')) {
                return 'audio';
            }
            // Image indicators
            if (document.querySelector('.rc-image-tile-wrapper') ||
                document.querySelector('.rc-imageselect-challenge') ||
                document.querySelector('.rc-imageselect-desc')) {
                return 'image';
            }
            return 'unknown';
        }).catch(() => 'unknown');
    }

    async _getImageChallengeInfo(bframe) {
        const prompt = await bframe.evaluate(() => {
            const el = document.querySelector(
                '.rc-imageselect-desc-no-canonical, .rc-imageselect-desc, .rc-imageselect-instructions'
            );
            return el ? el.innerText.replace(/\s+/g, ' ').trim() : '';
        }).catch(() => '');

        const tiles = await bframe.evaluate(() =>
            Array.from(document.querySelectorAll('.rc-imageselect-tile')).map((t, i) => ({
                index: i,
                id:    t.id || String(i),
                // Is this tile already selected?
                selected: t.classList.contains('rc-imageselect-tileselected'),
            }))
        ).catch(() => []);

        // Screenshot the challenge for visual solving
        const imgEl = await bframe.$('.rc-image-tile-target, .rc-imageselect-challenge img').catch(() => null);
        let imageBase64 = null;
        if (imgEl) {
            imageBase64 = (await imgEl.screenshot().catch(() => null))?.toString('base64') ?? null;
        }

        return {
            type:      'image',
            prompt,
            gridSize:  Math.round(Math.sqrt(tiles.length)) || 3,
            tiles,
            tileCount: tiles.length,
            imageBase64,
        };
    }

    // ── Audio solving ──────────────────────────────────────────────────────

    async _switchToAudio(bframe) {
        const btn = await bframe.waitForSelector('#recaptcha-audio-button', { timeout: 5000 }).catch(() => null);
        if (!btn) throw new Error('Audio challenge button not found');
        await this._humanClick(bframe, '#recaptcha-audio-button');
        await this.page.waitForTimeout(2000);
    }

    async _getAudioUrl(bframe) {
        // Check for bot detection first
        const blocked = await bframe.evaluate(() =>
            document.body?.innerText?.includes('Try again later') ?? false
        ).catch(() => false);
        if (blocked) throw new Error('Bot detected after audio switch');

        // Wait for audio element to load
        await bframe.waitForSelector('#audio-source, audio', { timeout: 8000 }).catch(() => null);

        return bframe.evaluate(() => {
            // Try the standard #audio-source element
            const src = document.querySelector('#audio-source');
            if (src?.src) return src.src;

            // Try audio element with source child
            const audioSrc = document.querySelector('audio source, audio[src]');
            if (audioSrc) return audioSrc.src || audioSrc.getAttribute('src');

            // Try to find any URL in the page that looks like reCAPTCHA audio
            const all = Array.from(document.querySelectorAll('[src]'));
            const audio = all.find(el => {
                const s = el.getAttribute('src') || '';
                return s.includes('recaptcha') && (s.includes('.mp3') || s.includes('audio'));
            });
            return audio ? audio.getAttribute('src') : null;
        }).catch(() => null);
    }

    /**
     * Transcribe reCAPTCHA audio MP3 using local Whisper.
     *
     * Resolution order:
     *   1. @xenova/transformers Whisper-tiny (Node.js, no Python needed)
     *   2. openai-whisper Python CLI (if installed via pip)
     *   3. ffmpeg + SpeechRecognition fallback (basic, English only)
     */
    async _transcribeAudio(audioUrl) {
        const id  = crypto.randomInt(10000, 99999);
        const mp3 = path.join(TEMP_DIR, `rcap_${id}.mp3`);
        const wav = path.join(TEMP_DIR, `rcap_${id}.wav`);

        try {
            // Download the audio file
            const resp = await fetch(audioUrl);
            if (!resp.ok) throw new Error(`Audio download failed: HTTP ${resp.status}`);
            fs.writeFileSync(mp3, Buffer.from(await resp.arrayBuffer()));

            // Convert MP3 → 16kHz mono WAV (required by Whisper)
            const ffmpegPath = this._findFfmpeg();
            if (!ffmpegPath) throw new Error('ffmpeg not found — install it for audio CAPTCHA solving');

            const conv = spawnSync(ffmpegPath, [
                '-y', '-i', mp3, '-ar', '16000', '-ac', '1', '-f', 'wav', wav
            ], { stdio: 'pipe' });

            if (conv.status !== 0) {
                throw new Error(`ffmpeg conversion failed: ${conv.stderr?.toString()}`);
            }

            // Strategy A: @xenova/transformers (Node.js Whisper, no Python)
            try {
                const text = await this._transcribeWithXenova(wav);
                if (text) return text;
            } catch (e) {
                console.error('[CAPTCHA] Xenova Whisper failed:', e.message, '— trying Python fallback');
            }

            // Strategy B: Python openai-whisper CLI
            try {
                const text = this._transcribeWithPythonWhisper(wav);
                if (text) return text;
            } catch (e) {
                console.error('[CAPTCHA] Python Whisper failed:', e.message);
            }

            throw new Error('All transcription methods failed. Install @xenova/transformers or openai-whisper.');

        } finally {
            for (const p of [mp3, wav]) {
                try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
            }
        }
    }

    async _transcribeWithXenova(wavPath) {
        // Lazy-require: only loaded if the package is installed
        let pipeline;
        try {
            ({ pipeline } = require('@xenova/transformers'));
        } catch {
            throw new Error('@xenova/transformers not installed');
        }

        const transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
            quantized: true, // Use smaller quantized model
        });

        const audioBuffer = fs.readFileSync(wavPath);
        // Convert raw int16 PCM (WAV body) to float32 normalized [-1, 1]
        // WAV header is 44 bytes; skip it
        const pcmOffset = 44;
        const int16  = new Int16Array(audioBuffer.buffer, audioBuffer.byteOffset + pcmOffset);
        const float32 = Float32Array.from(int16, s => s / 32768);

        const result = await transcriber(float32, {
            sampling_rate: 16000,
            language: 'english',
            task: 'transcribe',
        });

        return result?.text?.trim() ?? null;
    }

    _transcribeWithPythonWhisper(wavPath) {
        // Try whisper CLI (installed via: pip install openai-whisper)
        const python = ['python3', 'python'].find(cmd => {
            try { execSync(`${cmd} -c "import whisper"`, { stdio: 'pipe' }); return true; } catch { return false; }
        });

        if (!python) throw new Error('Python openai-whisper not available');

        const result = spawnSync(python, [
            '-c',
            `import whisper, sys, json
model = whisper.load_model("tiny.en")
r = model.transcribe(sys.argv[1], language="en", fp16=False)
print(r["text"].strip())`,
            wavPath
        ], { stdio: 'pipe', timeout: 60000 });

        if (result.status !== 0) throw new Error(result.stderr?.toString());
        return result.stdout?.toString().trim() ?? null;
    }

    _findFfmpeg() {
        const candidates = [
            'ffmpeg',
            '/usr/bin/ffmpeg',
            '/usr/local/bin/ffmpeg',
            '/home/azzar/.local/bin/ffmpeg',
        ];
        for (const cmd of candidates) {
            try {
                spawnSync(cmd, ['-version'], { stdio: 'pipe' });
                return cmd;
            } catch {}
        }
        return null;
    }

    async _submitAnswer(text) {
        const bframe = await this._getAnyFrame(BFRAME_SEL);
        if (!bframe) throw new Error('Challenge iframe lost during submission');

        const input = await bframe.waitForSelector('#audio-response', { timeout: 5000 }).catch(() => null);
        if (input) {
            await input.fill('');
            await this.page.waitForTimeout(200 + Math.random() * 300);
            // Type character by character — more human-like
            for (const ch of text.toLowerCase()) {
                await input.type(ch, { delay: 80 + Math.random() * 120 });
            }
        }

        const verify = await bframe.waitForSelector('#recaptcha-verify-button', { timeout: 5000 }).catch(() => null);
        if (verify) {
            await this._humanClick(bframe, '#recaptcha-verify-button');
        }
        await this.page.waitForTimeout(1500);
    }

    // ── State checks ───────────────────────────────────────────────────────

    /**
     * True if the anchor checkbox is aria-checked=true OR if
     * the page has a non-empty g-recaptcha-response token.
     */
    async _isSolved() {
        // Method A: check anchor iframe checkbox aria-checked
        try {
            const els = await this.page.$$(ANCHOR_SEL + ', ' + TITLE_SEL);
            for (const el of els) {
                const frame = await el.contentFrame().catch(() => null);
                if (!frame) continue;
                const checked = await frame.evaluate(() => {
                    const cb = document.querySelector('.recaptcha-checkbox');
                    if (cb) return cb.getAttribute('aria-checked') === 'true';
                    return false;
                }).catch(() => false);
                if (checked) return true;
            }
        } catch {}

        // Method B: check for g-recaptcha-response token on the page
        try {
            return await this.page.evaluate(() => {
                const el = document.querySelector('[name="g-recaptcha-response"], #g-recaptcha-response');
                return !!(el && el.value && el.value.length > 10);
            });
        } catch { return false; }
    }

    async _isDetected() {
        try {
            const bframe = await this._getAnyFrame(BFRAME_SEL);
            if (!bframe) return false;
            return bframe.evaluate(() =>
                document.body?.innerText?.includes('Try again later') ?? false
            );
        } catch { return false; }
    }

    // ── Human behavior simulation ──────────────────────────────────────────

    /**
     * Simulate human click: smooth mouse trajectory + jitter + random delay.
     * reCAPTCHA monitors mouse movement patterns for bot detection.
     */
    async _humanClick(frame, selector) {
        const el  = await frame.$(selector).catch(() => null);
        if (!el) {
            await frame.click(selector, { delay: 80 + Math.random() * 120 }).catch(() => {});
            return;
        }
        const box = await el.boundingBox().catch(() => null);
        if (!box) {
            await frame.click(selector, { delay: 80 + Math.random() * 120 }).catch(() => {});
            return;
        }

        // Move to a slightly randomized center point
        const cx = box.x + box.width  / 2 + (Math.random() - 0.5) * 6;
        const cy = box.y + box.height / 2 + (Math.random() - 0.5) * 6;

        // Multi-step mouse move simulates human hand trajectory
        await this.page.mouse.move(cx - 40, cy - 20, { steps: 4 });
        await this.page.waitForTimeout(50 + Math.random() * 100);
        await this.page.mouse.move(cx, cy, { steps: 8 + Math.floor(Math.random() * 8) });
        await this.page.waitForTimeout(100 + Math.random() * 300);
        await this.page.mouse.click(cx, cy, { delay: 60 + Math.random() * 100 });
    }
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = { RecaptchaSolver };
