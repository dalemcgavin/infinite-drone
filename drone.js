// --- Audio Engine ---

const DEGREE_OFFSETS = {
    '1': 0, 'b2': 1, '2': 2, 'b3': 3, '3': 4, '4': 5,
    '#4': 6, '5': 7, 'b6': 8, '6': 9, 'b7': 10, '7': 11
};

function midiToHz(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
}

class Drone {
    constructor(rootMidi) {
        this.ctx = new AudioContext();
        this.currentMidi = rootMidi;
        this.lastMidi = null;
        this.oscs = [];

        const now = this.ctx.currentTime;

        this.master = this.ctx.createGain();
        this.master.gain.setValueAtTime(0, now);
        this.master.connect(this.ctx.destination);

        const comp = this.ctx.createDynamicsCompressor();
        comp.threshold.value = -20;
        comp.ratio.value = 3;
        comp.attack.value = 0.01;
        comp.release.value = 0.3;
        this.master.connect(comp);
        comp.connect(this.ctx.destination);

        this.filter = this.ctx.createBiquadFilter();
        this.filter.type = 'lowpass';
        this.filter.frequency.setValueAtTime(200, now);
        this.filter.frequency.linearRampToValueAtTime(2000, now + 4);
        this.filter.Q.value = 1.0;

        const shaper = this.ctx.createWaveShaper();
        const drive = 2.0;
        const curveLen = 1024;
        const curve = new Float32Array(curveLen);
        const norm = Math.tanh(drive);
        for (let i = 0; i < curveLen; i++) {
            const x = (i / (curveLen - 1)) * 2 - 1;
            curve[i] = Math.tanh(drive * x) / norm;
        }
        shaper.curve = curve;

        this.filter.connect(shaper);
        shaper.connect(this.master);

        const reverb = this.ctx.createConvolver();
        reverb.buffer = this._makeImpulse(3.0);
        const wetGain = this.ctx.createGain();
        wetGain.gain.value = 0.3;
        this.filter.connect(reverb);
        reverb.connect(wetGain);
        wetGain.connect(this.master);

        const delay = this.ctx.createDelay(1.0);
        delay.delayTime.value = 0.35;
        const feedback = this.ctx.createGain();
        feedback.gain.value = 0.4;
        this.feedback = feedback;
        const delayGain = this.ctx.createGain();
        delayGain.gain.value = 0.15;
        this.filter.connect(delay);
        delay.connect(feedback);
        feedback.connect(delay);
        delay.connect(delayGain);
        delayGain.connect(this.master);

        const vib = this.ctx.createOscillator();
        vib.type = 'sine';
        vib.frequency.value = 5.5;
        const vibGain = this.ctx.createGain();
        vibGain.gain.value = 8;
        vib.connect(vibGain);
        vib.start();

        const lfo2 = this.ctx.createOscillator();
        lfo2.type = 'sine';
        lfo2.frequency.value = 0.13;
        const lfo2Gain = this.ctx.createGain();
        lfo2Gain.gain.value = 4;
        lfo2.connect(lfo2Gain);
        lfo2.start();

        const lfo3 = this.ctx.createOscillator();
        lfo3.type = 'sine';
        lfo3.frequency.value = 0.19;
        const lfo3Gain = this.ctx.createGain();
        lfo3Gain.gain.value = 0.05;
        lfo3.connect(lfo3Gain);
        lfo3Gain.connect(this.master.gain);
        lfo3.start();

        this.lfos = [vib, lfo2, lfo3]
        const configs = [
            { detune: 0,  vol: 0.4, pan: -0.6 },
            { detune: 7,  vol: 0.2, pan: -0.2 },
            { detune: -5, vol: 0.2, pan: 0.0 },
            { detune: 3,  vol: 0.1, pan: 0.3 },
            { detune: -8, vol: 0.2, pan: 0.7 },
        ];

        for (const { detune, vol, pan } of configs) {
            const osc = this.ctx.createOscillator();
            osc.type = 'sawtooth';
            osc.frequency.value = midiToHz(this.currentMidi);
            osc.detune.value = detune;

            const g = this.ctx.createGain();
            g.gain.value = vol;

            const panner = this.ctx.createStereoPanner();
            panner.pan.value = pan;

            osc.connect(g);
            g.connect(panner);
            panner.connect(this.filter);
            osc.start();

            vibGain.connect(osc.detune);
            lfo2Gain.connect(osc.detune);

            this.oscs.push(osc);
        }

        // Just intonation 5th: root × 1.5 (exactly 3:2)
        const fifthHz = midiToHz(this.currentMidi) * 1.5;

        // Add 2-3 quieter voices at the 5th (same detune/pan spread, lower volume)
        const fifthConfigs = [
            { detune: 0,  vol: 0.15, pan: -0.4 },
            { detune: 5,  vol: 0.1,  pan: 0.2 },
            { detune: -4, vol: 0.05, pan: 0.5 },
        ];

        for (const { detune, vol, pan } of fifthConfigs) {
            const osc = this.ctx.createOscillator();
            osc.type = 'sawtooth';
            osc.frequency.value = fifthHz;
            osc.detune.value = detune;

            const g = this.ctx.createGain();
            g.gain.value = vol;

            const panner = this.ctx.createStereoPanner();
            panner.pan.value = pan;

            osc.connect(g);
            g.connect(panner);
            panner.connect(this.filter);
            osc.start();

            vibGain.connect(osc.detune);
            lfo2Gain.connect(osc.detune);

            this.oscs.push(osc);
        }   

        this.master.gain.linearRampToValueAtTime(0.3, now + 4);
    }

    setRoot(midi) {
        this.currentMidi = midi;
        const now = this.ctx.currentTime;
        const rootHz = midiToHz(midi);
        const fifthHz = rootHz * 1.5;

        // First 5 oscs are the root, next 3 are the 5th
        this.oscs.forEach((osc, i) => {
            const target = i < 5 ? rootHz : fifthHz;
            osc.frequency.setTargetAtTime(target, now, 0.3);
        });
    }
    _makeImpulse(seconds) {
        const rate = this.ctx.sampleRate;
        const length = rate * seconds;
        const buffer = this.ctx.createBuffer(2, length, rate);
        for (let ch = 0; ch < 2; ch++) {
            const data = buffer.getChannelData(ch);
            for (let i = 0; i < length; i++) {
                const t = i / length;
                data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.5);
            }
        }
        return buffer;
    }

    playDegree(degree, octave = 4) {
        const offset = DEGREE_OFFSETS[degree];
        if (offset === undefined) return;

        const midi = this.currentMidi + offset + 12 * (octave - 2);
        const hz = midiToHz(midi);
        const now = this.ctx.currentTime;

        const osc = this.ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = hz;

        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.3, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 1.5);

        osc.connect(g);
        g.connect(this.ctx.destination);
        osc.start();
        osc.stop(now + 1.5);

        this.lastMidi = midi;
    }

    replay() {
        if (this.lastMidi === null) return;
        const hz = midiToHz(this.lastMidi);
        const now = this.ctx.currentTime;

        const osc = this.ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = hz;

        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.3, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 1.5);

        osc.connect(g);
        g.connect(this.ctx.destination);
        osc.start();
        osc.stop(now + 1.5);
    }

    stop() {
        const now = this.ctx.currentTime;
        this.master.gain.setValueAtTime(this.master.gain.value, now);
        this.master.gain.linearRampToValueAtTime(0, now + 1);
        this.feedback.gain.setValueAtTime(this.feedback.gain.value, now);
        this.feedback.gain.linearRampToValueAtTime(0, now + 2.5);
        for (const osc of this.oscs) {
            osc.stop(now + 2.5);
        }

        for (const lfo of this.lfos) {
            try { lfo.stop(now + 1); } catch (e) {}
        }
        setTimeout(() => { this.ctx.close(); }, 2500);
    }
}

// --- UI ---

const CIRCLE_ORDER = ['1','5','2','6','3','7','#4','b2','b6','b3','b7','4'];
const DEGREES = [
    { label: '1',   offset: 0 },
    { label: 'b2',  offset: 1 },
    { label: '2',   offset: 2 },
    { label: 'b3',  offset: 3 },
    { label: '3',   offset: 4 },
    { label: '4',   offset: 5 },
    { label: '#4',  offset: 6 },
    { label: '5',   offset: 7 },
    { label: 'b6',  offset: 8 },
    { label: '6',   offset: 9 },
    { label: 'b7',  offset: 10 },
    { label: '7',   offset: 11 },
];

const PRESETS = {
    major:      [0, 2, 4, 5, 7, 9, 11],
    minor:      [0, 2, 3, 5, 7, 8, 10],
    pentatonic: [0, 2, 4, 7, 9],
    all:        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

let drone = null;
let active = new Set(PRESETS.major);
let questionDegree = null;
let asked = false;
let mode = 'free'; // 'free' or 'question'

const circle = document.getElementById('circle');
const readout = document.getElementById('readout');
const toggles = document.getElementById('degree-toggles');

function flash(color) {
    const el = document.createElement('div');
    el.style.cssText = `
        position: absolute;
        top: 50%; left: 50%;
        width: calc(min(280px, 75vw) * 0.8);
        height: calc(min(280px, 75vw) * 0.8);
        border-radius: 50%;
        border: 3px solid ${color};
        background: transparent;
        pointer-events: none;
        z-index: 10;
        transform: translate(-50%, -50%) scale(0);
        animation: ripple 0.8s ease-out forwards;
    `;
    circle.appendChild(el);
    setTimeout(() => el.remove(), 800);
}         

function clearHighlight() {
    circle.querySelectorAll('.note').forEach(n => n.classList.remove('active'));
    readout.textContent = '';
}

function askQuestion() {
    const pool = DEGREES.filter(d => active.has(d.offset));
    if (pool.length === 0) return;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    const octave = 3 + Math.floor(Math.random() * 4); // 2–5
    drone.playDegree(pick.label, octave);
    questionDegree = pick.label;
    asked = true;
    clearHighlight();
}

// Build circle
CIRCLE_ORDER.forEach((label, i) => {
    const el = document.createElement('div');
    el.className = 'note';
    el.textContent = label;
    el.style.setProperty('--angle', `${i * 30}deg`);

    el.addEventListener('click', () => {
        if (mode === 'question' && asked && questionDegree) {
            if (label === questionDegree) {
                flash('#4aff4a');
                // Correct → next question
                setTimeout(() => askQuestion(), 600);
            } else {
                flash('#ff4a4a');
                // Wrong → replay same question
                setTimeout(() => drone.replay(), 600);
            }
            clearHighlight();
            return;
        }

        // Free mode — just play the note
        circle.querySelectorAll('.note').forEach(n => n.classList.remove('active'));
        el.classList.add('active');
        readout.textContent = label;
        drone?.playDegree(label);
    });

    circle.appendChild(el);
});

// Build toggles
DEGREES.forEach(d => {
    const btn = document.createElement('button');
    btn.textContent = d.label;
    btn.className = active.has(d.offset) ? 'active' : '';
    btn.addEventListener('click', () => {
        if (active.has(d.offset)) {
            active.delete(d.offset);
            btn.classList.remove('active');
        } else {
            active.add(d.offset);
            btn.classList.add('active');
        }
    });
    toggles.appendChild(btn);
});

document.getElementById('play').addEventListener('click', async () => {
    const btn = document.getElementById('play');

    if (drone) {
        drone.stop();
        drone = null;
        btn.textContent = 'Play';
        clearHighlight();
    } else {
        if ('audioSession' in navigator) {
            navigator.audioSession.type = 'playback';
        }
        const root = 36 + Math.floor(Math.random() * 12);
        drone = new Drone(root);
        await drone.ctx.resume();
        btn.textContent = 'Pause';
        clearHighlight();
    }
});   

document.getElementById('key-change').addEventListener('click', () => {
    if (!drone) return;
    const root = 36 + Math.floor(Math.random() * 12); // C2–B2
    drone.setRoot(root);
    clearHighlight();
    asked = false;
});

document.getElementById('question').addEventListener('click', () => {
    if (!drone) return;
    mode = 'question';

    if (asked) {
        drone.replay();
    } else {
        askQuestion();
    }
});   
document.getElementById('free').addEventListener('click', () => {
    mode = 'free';
    questionDegree = null;
    asked = false;
    clearHighlight();
});   

// Presets
document.querySelectorAll('#presets button').forEach(btn => {
    btn.addEventListener('click', () => {
        const preset = PRESETS[btn.dataset.preset];
        active = new Set(preset);

        // Update toggle buttons
        document.querySelectorAll('#degree-toggles button').forEach((t, i) => {
            t.classList.toggle('active', active.has(DEGREES[i].offset));
        });

        // Highlight the active preset button
        document.querySelectorAll('#presets button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
    });
});
