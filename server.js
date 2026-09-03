// Standalone static file server + /api/chat, backed by a local Ollama
// instance instead of a cloud API. RAG: retrieves matching chunks from
// admin-uploaded documents (data/rag.js) and feeds them to the model as
// context instead of letting it free-generate medical advice.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const rag = require('./data/rag.js');

const PORT = process.env.PORT || 3000;
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434/api/chat';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3.5:0.8b';
// KV-cache RAM scales with this; default context window is what was pushing
// Ollama past ~2.9GB. Chat here is short (system prompt + few turns), so a
// smaller window is plenty and keeps the process under ~1GB.
const OLLAMA_NUM_CTX = Number(process.env.OLLAMA_NUM_CTX) || 1024;
const OLLAMA_TEMPERATURE = Number(process.env.OLLAMA_TEMPERATURE) || 0.15;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const MAX_HISTORY_MESSAGES = 8;

function isAdmin(req) {
    if (!ADMIN_TOKEN) return false;
    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const a = Buffer.from(token);
    const b = Buffer.from(ADMIN_TOKEN);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const MIME = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.png': 'image/png', '.webmanifest': 'application/manifest+json'
};

function serveStatic(req, res) {
    let urlPath;
    try { urlPath = decodeURIComponent(req.url.split('?')[0]); }
    catch { return res.writeHead(400).end('Bad request'); }

    // Block dotfiles/dot-dirs (.git, .env, .claude, ...) and anything not in
    // the MIME allowlist, so the static server can't be used to read source
    // or config files off the disk — only the site's own known asset types.
    if (urlPath.split('/').some((seg) => seg.startsWith('.'))) return res.writeHead(403).end('Forbidden');

    const filePath = path.join(__dirname, urlPath === '/' ? 'index.html' : urlPath);
    const root = __dirname + path.sep;
    if (filePath !== __dirname && !filePath.startsWith(root)) return res.writeHead(403).end('Forbidden');

    const ext = path.extname(filePath);
    if (!MIME[ext]) return res.writeHead(404).end('Not found');

    fs.readFile(filePath, (err, data) => {
        if (err) return res.writeHead(404).end('Not found');
        res.writeHead(200, { 'Content-Type': MIME[ext] });
        res.end(data);
    });
}

const MAX_CHAT_BODY_BYTES = 64 * 1024; // chat messages are short
const MAX_UPLOAD_BODY_BYTES = 20 * 1024 * 1024; // base64 PDF/txt/md, generous but bounded

function readBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
        const parts = [];
        let bytes = 0;
        req.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > maxBytes) {
                reject(new Error('Body too large'));
                req.destroy();
                return;
            }
            parts.push(chunk);
        });
        req.on('end', () => {
            try { resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); }
            catch (e) { reject(e); }
        });
        req.on('error', reject);
    });
}

function isCrisisMessage(userText) {
    const normalized = String(userText)
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (/\b(suicide|suicidal|self harm|kms|kys)\b/.test(normalized)) return true;
    if (/\b(kill\s+my\s*self|hurt\s+my\s*self|end\s+my\s+life|don't\s+want\s+to\s+live|do\s+not\s+want\s+to\s+live)\b/.test(normalized)) return true;
    return /\b(want|wants|wanted|wanna|thinking about|thinking of|plan to|planning to|going to|feel like)\b.{0,32}\b(die|dying|kill|killing|hurt|ending)\b/.test(normalized)
        && /\b(myself|my self|me|my life|dead|die|dying)\b/.test(normalized);
}

function detectEmotionalState(userText) {
    const normalized = String(userText).toLowerCase();
    const states = [
        ['grief', ['died', 'death', 'passed away', 'lost my', 'grieving', 'grief', 'mourning']],
        ['panic', ['panic attack', 'panicking', 'cannot calm down', 'can t calm down', 'heart is racing', 'hard to breathe']],
        ['anxiety', ['anxious', 'anxiety', 'worried', 'worrying', 'nervous', 'scared', 'afraid']],
        ['loneliness', ['alone', 'lonely', 'no one', 'nobody', 'isolated', 'left out']],
        ['anger', ['angry', 'furious', 'mad', 'rage', 'irritated', 'annoyed']],
        ['shame', ['ashamed', 'embarrassed', 'humiliated', 'worthless', 'failure']],
        ['frustration', ['frustrated', 'frustrating', 'fed up', 'stuck', 'cannot handle', 'can t handle']],
        ['overwhelm', ['overwhelmed', 'too much', 'everything on me', 'under pressure', 'stressed', 'stress']]
    ];
    return states.find(([, terms]) => terms.some((term) => normalized.includes(term)))?.[0] || 'general';
}

const INTENT_TERMS = {
    emergency: ['emergency', 'urgent', '911', 'unconscious', 'not breathing', 'cannot breathe', 'can t breathe', 'chest pain', 'severe bleeding', 'heavy bleeding', 'stroke'],
    emotional_support: ['sad', 'scared', 'afraid', 'anxious', 'anxiety', 'overwhelmed', 'alone', 'lonely', 'upset', 'stressed', 'crying', 'grief', 'grieving', 'mourning', 'died', 'death', 'passed away', 'lost my', 'dog died', 'cat died', 'pet died', 'worried', 'panic', 'too much', 'everything on me', 'pressure', 'can t cope', 'need support', 'talk to me', 'can you talk', 'listen to me', 'emotional support'],
    wound_care: ['wound', 'cut', 'scrape', 'bleeding', 'blood', 'gauze', 'bandage', 'antiseptic', 'saline', 'splinter'],
    burn_care: ['burn', 'scald', 'hot water', 'chemical burn', 'electrical burn', 'non stick dressing'],
    injury_support: ['sprain', 'strain', 'swelling', 'swollen', 'puffy', 'twisted ankle', 'turned ankle', 'hurt ankle', 'bruise', 'bump', 'cold pack', 'cold compress', 'elastic bandage', 'sling'],
    temperature: ['temperature', 'fever', 'thermometer', 'mainit ang katawan', 'lagnat'],
    hygiene: ['hand hygiene', 'sanitize', 'sanitizer', 'gloves', 'mask', 'infection control', 'wash my hands'],
    cpr: ['cpr', 'rescue breathing', 'face shield', 'cardiopulmonary'],
    hospital_lookup: ['hospital', 'clinic', 'doctor', 'emergency room', 'nearest', 'malapit na ospital'],
    medkit_inventory: ['medkit', 'first aid kit', 'first-aid kit', 'what do i need', 'supplies', 'equipment']
};

const INTENT_EXPANSIONS = {
    emergency: 'urgent emergency immediate danger call 911 professional help',
    emotional_support: 'emotional support overwhelmed worried lonely trusted adult counselor',
    wound_care: 'minor wound cut scrape bleeding gauze bandage clean dressing first aid',
    burn_care: 'minor burn scald burn dressing non stick dressing first aid',
    injury_support: 'minor injury sprain swelling bump bruise cold compress elastic bandage support',
    temperature: 'check body temperature fever digital thermometer',
    hygiene: 'hand hygiene gloves masks infection control first aid',
    cpr: 'CPR rescue breathing face shield barrier emergency services',
    hospital_lookup: 'hospital clinic emergency department healthcare professional nearby',
    medkit_inventory: 'basic first aid kit inventory supplies purpose use'
};

function classifyIntent(userText) {
    const normalized = String(userText).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const scores = Object.entries(INTENT_TERMS).map(([intent, terms]) => [
        intent,
        terms.reduce((score, term) => score + (normalized.includes(term) ? (term.includes(' ') ? 2 : 1) : 0), 0)
    ]).sort((a, b) => b[1] - a[1]);
    return scores[0][1] ? scores[0][0] : 'general_health';
}

function buildEmotionalSupportReply(userText, history = []) {
    if (isCrisisMessage(userText)) {
        return 'I am sorry you are facing this, and your safety matters. **Are you in immediate danger, or have you already hurt yourself or someone else?**\n\nIf yes, call **911** now, go to the nearest emergency department, and tell a trusted adult who can stay with you. Move away from anything you could use to cause harm and stay with another person.';
    }

    const cleanedText = userText.trim().replace(/[.!?]+$/, '');
    const hasFollowedUp = history.some((message) => message.role === 'model');
    if (/\b(can you talk|talk to me|listen to me)\b/i.test(cleanedText)) {
        return 'Yes, we can talk. I will listen without judging you. You can start with whatever feels easiest, even if it is only a few words.\n\n**What is happening for you right now?**';
    }
    if (/\b(died|death|passed away|lost my|grieving|grief|mourning)\b/i.test(cleanedText)) {
        return `I am sorry about your loss. Losing someone or a beloved pet can hurt deeply, and there is no single right way to grieve.\n\nBe gentle with yourself today. You could remember them by talking with someone you trust, looking at a favorite photo, or taking a quiet moment.\n\n**Would you like to tell me about them, or would you rather have quiet support right now?**`;
    }
    const state = detectEmotionalState(cleanedText);
    const stateGuidance = {
        panic: 'Try placing both feet on the floor and taking a slow breath out longer than you breathe in.',
        anxiety: 'Name one thing you can control in the next few minutes and let the rest wait for now.',
        loneliness: 'If possible, send a simple message to someone safe, such as "Can we talk for a few minutes?"',
        anger: 'Give yourself a little space before responding, and try a slow breath or a short walk.',
        shame: 'A difficult moment does not define your worth. Speak to yourself as gently as you would speak to someone you care about.',
        frustration: 'Pause and choose the smallest part of the problem that you can handle first.',
        overwhelm: 'You do not have to solve everything at once. Choose one small next step.',
        general: 'Take one slow breath and focus on what you need in this moment.'
    }[state];
    const reflection = cleanedText.length <= 90
        ? `It sounds like **${cleanedText.toLowerCase()}** is weighing on you.`
        : 'It sounds like you are carrying a lot right now.';
    const question = hasFollowedUp
        ? '**Would it help to talk about what happened, or would you rather focus on calming down first?**'
        : '**What part of this feels heaviest right now?**';
    return `${reflection}\n\n${stateGuidance} Be kind to yourself; this feeling does not define you. If you can, contact a trusted adult, family member, school counselor, or healthcare professional.\n\n${question}`;
}

function buildDefaultRagReply(matches) {
    const facts = [...new Set(matches.map((match) => match.text.trim()))].slice(0, 2);
    return `Based on the MedisinACSHS medkit reference:\n\n${facts.join('\n\n')}\n\nFollow the product label and seek professional help if the injury is severe or worsening.`;
}

async function handleChat(req, res) {
    let body;
    try { body = await readBody(req, MAX_CHAT_BODY_BYTES); }
    catch { return res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Invalid JSON body' })); }

    const { contents, system_instruction } = body;
    if (!Array.isArray(contents) || contents.length === 0) {
        return res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'contents array missing' }));
    }

    const systemText = (system_instruction?.parts?.[0]?.text || '').trim();
    const lastUserText = [...contents].reverse()
        .find((c) => c?.role !== 'model')?.parts?.map((p) => p?.text || '').join('\n') || '';

    if (isCrisisMessage(lastUserText)) {
        return sendJson(res, 200, { reply: buildEmotionalSupportReply(lastUserText, contents) });
    }

    const intent = classifyIntent(lastUserText);
    if (intent === 'emotional_support') {
        return sendJson(res, 200, { reply: buildEmotionalSupportReply(lastUserText, contents) });
    }

    const retrievalQuery = `${lastUserText} ${INTENT_EXPANSIONS[intent] || ''}`;
    const matches = rag.topChunks(retrievalQuery, 4);
    const isGreeting = /^(hello|hi|hey)([!?,.\s]|$)/i.test(lastUserText.trim());
    if (!matches.length && !isGreeting) {
        return sendJson(res, 200, {
            reply: 'I do not have that information in my health-information dataset yet. Please ask about a topic covered by the uploaded documents, or call 911 and tell an adult if this is urgent.'
        });
    }

    if (matches.some((match) => match.source === 'emotional-support.md') && !isGreeting) {
        return sendJson(res, 200, { reply: buildEmotionalSupportReply(lastUserText, contents) });
    }

    if (matches.length && matches.every((match) => match.source === 'medkit-inventory.md')) {
        return sendJson(res, 200, { reply: buildDefaultRagReply(matches) });
    }

    const contextBlock = matches.length
        ? 'RETRIEVED HEALTH DATA (the only factual source you may use):\n' + matches.map((m) => `[Source: ${m.source}] ${m.text}`).join('\n')
        : 'RETRIEVED HEALTH DATA: (no matching entry in the health-info dataset)';
    const prompt = `${systemText}

You are a grounded healthcare information assistant, not a diagnosing clinician.
Classify the user's goal as ${intent.replace('_', ' ')} and answer only the question they actually asked. Use the retrieved health data as your factual source; the intent is a routing hint, not a source of facts. Do not diagnose, infer a condition from a symptom, or recommend emergency care unless the retrieved data explicitly supports it.
Use the retrieved health data as your factual source. Do not invent, extrapolate, or fill gaps from general model knowledge.
If the data does not answer the user's question, say so plainly and give only the urgent-safety instruction already provided.
Give concise, ordered steps when the data supports them. Preserve important warnings, limits, timing, dosages, contraindications, and escalation instructions from the data.
Ask at most one short follow-up question when the answer depends on missing information. Do not ask a follow-up for a clear emergency; direct the user to emergency help first.
When the retrieved data is about emotional support, use this short structure: acknowledge the feeling, offer one small next step, then ask one complete gentle question. Ask whether the person is safe when appropriate. Never pretend to be human, say that you are physically present, tell the person to reassure you, or say "tell me that I am here". Treat mentions of self-harm, suicide, violence, or immediate danger as urgent and direct the person to 911, emergency care, and a trusted adult.
Format the response as plain Markdown only: use **bold** for urgent actions or key terms, *italics* sparingly, and hyphen bullets or numbered lists for steps. Do not use HTML tags, Markdown tables, decorative symbols, emoji, or repeated punctuation. Keep each response short and complete.
${contextBlock}`;

    const messages = [
        {
            role: 'system',
            content: prompt
        },
        ...contents.slice(-MAX_HISTORY_MESSAGES).map((c) => ({
            role: c?.role === 'model' ? 'assistant' : 'user',
            content: (c?.parts || []).map((p) => p?.text || '').join('\n').trim()
        })).filter((m) => m.content)
    ];

    try {
        const ollamaRes = await fetch(OLLAMA_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // think:false — qwen3.5 is a hybrid reasoning model; left on, it burns
            // the whole output budget on its internal chain-of-thought and hits
            // done_reason:"length" before ever writing message.content.
            body: JSON.stringify({ model: OLLAMA_MODEL, stream: false, think: false, messages, options: { num_ctx: OLLAMA_NUM_CTX, temperature: OLLAMA_TEMPERATURE, top_p: 0.8, repeat_penalty: 1.1, num_predict: 350 } })
        });

        if (!ollamaRes.ok) {
            const detail = await ollamaRes.text();
            return res.writeHead(502, { 'Content-Type': 'application/json' })
                .end(JSON.stringify({ error: `Ollama returned ${ollamaRes.status}`, detail }));
        }

        const data = await ollamaRes.json();
        const reply = data?.message?.content;
        if (!reply) {
            return res.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Ollama returned no reply', raw: data }));
        }

        const cleanedReply = reply
            .split('\n')
            .filter((line) => !/physically present|here with you to help|we can help each other feel better/i.test(line))
            .join('\n')
            .trim();
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ reply: cleanedReply || reply }));
    } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify({
            error: `Could not reach Ollama at ${OLLAMA_URL}. Is "ollama serve" running and is the ${OLLAMA_MODEL} model pulled?`,
            detail: err.message
        }));
    }
}

function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

// Admin: manage the RAG document store. Auth: `Authorization: Bearer <ADMIN_TOKEN>`.
// Upload is JSON {filename, contentBase64} rather than multipart — avoids
// pulling in a multipart-parsing dependency for one form field.
async function handleAdmin(req, res, url) {
    if (!ADMIN_TOKEN) return sendJson(res, 503, { error: 'ADMIN_TOKEN not set on the server — admin routes disabled' });
    if (!isAdmin(req)) return sendJson(res, 401, { error: 'Invalid or missing admin token' });

    if (req.method === 'GET' && url.pathname === '/api/admin/docs') {
        return sendJson(res, 200, { docs: rag.listDocs() });
    }

    if (req.method === 'POST' && url.pathname === '/api/admin/docs') {
        let body;
        try { body = await readBody(req, MAX_UPLOAD_BODY_BYTES); }
        catch (e) { return sendJson(res, 400, { error: e.message === 'Body too large' ? 'File too large' : 'Invalid JSON body' }); }

        const { filename, contentBase64 } = body;
        if (!filename || !contentBase64) return sendJson(res, 400, { error: 'filename and contentBase64 required' });

        try {
            const doc = await rag.saveDoc(filename, Buffer.from(contentBase64, 'base64'));
            return sendJson(res, 200, { doc });
        } catch (e) {
            return sendJson(res, 400, { error: e.message });
        }
    }

    if (req.method === 'DELETE' && url.pathname === '/api/admin/docs') {
        const id = url.searchParams.get('id') || '';
        const ok = rag.deleteDoc(id);
        return sendJson(res, ok ? 200 : 404, ok ? { deleted: id } : { error: 'Document not found' });
    }

    sendJson(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api/chat' && req.method === 'POST') return handleChat(req, res);
    if (url.pathname.startsWith('/api/admin/')) return handleAdmin(req, res, url);
    if (req.method === 'GET') return serveStatic(req, res);
    res.writeHead(405).end('Method not allowed');
});

server.listen(PORT, () => {
    console.log(`MedisinACSHS running at http://localhost:${PORT}`);
    console.log(`Chat backed by Ollama model "${OLLAMA_MODEL}" at ${OLLAMA_URL}`);
    console.log(ADMIN_TOKEN ? `Admin panel at http://localhost:${PORT}/admin.html` : 'ADMIN_TOKEN not set — admin panel disabled');
});
