const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const cheerio = require('cheerio');

// === ЧТЕНИЕ .env ===
function loadEnv() {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) { console.error("❌ Нет .env"); process.exit(1); }
    const env = {};
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
        const [k, ...v] = line.split('=');
        if (k && v.length) env[k.trim()] = v.join('=').trim();
    }
    return env;
}
const ENV = loadEnv();
const API_KEY = ENV.DEEPSEEK_API_KEY;

if (!API_KEY || API_KEY.includes("sk-...")) {
    console.error("❌ Ключ не загружен! Проверь файл .env");
    process.exit(1);
}
console.log("✅ Ключ загружен, начинается с:", API_KEY.substring(0, 7) + "...");

// === НАСТРОЙКИ ===
const PORT = 3000;
const API_URL = "https://api.deepseek.com/chat/completions";
const MEMORY_FILE = path.join(__dirname, 'memory.json');
const FACTS_FILE = path.join(__dirname, 'facts.json');
const MAX_HISTORY = 20;      // сколько последних сообщений отправлять в API
const SUMMARY_TRIGGER = 30;  // при каком размере памяти запускаем суммаризацию
const SUMMARY_CHUNK = 10;    // сколько старых сообщений сжать
const CMD_WHITELIST = ['node', 'npm', 'git', 'dir', 'type', 'echo', 'cd', 'cls', 'ls', 'cat'];

// === ФАКТЫ ===
function loadFacts() {
    if (!fs.existsSync(FACTS_FILE)) {
        const empty = { user: { name: "Игорь" }, summary: "", notes: [] };
        fs.writeFileSync(FACTS_FILE, JSON.stringify(empty, null, 2));
        return empty;
    }
    return JSON.parse(fs.readFileSync(FACTS_FILE, 'utf8'));
}
function saveFacts(facts) {
    fs.writeFileSync(FACTS_FILE, JSON.stringify(facts, null, 2));
}
function factsToPrompt(facts) {
    let prompt = `\n\n=== ЧТО Я ЗНАЮ ОБ ИГОРЕ ===\n`;
    if (facts.user?.name) prompt += `Имя: ${facts.user.name}\n`;
    if (facts.summary) prompt += `Резюме прошлых бесед: ${facts.summary}\n`;
    if (facts.notes?.length) {
        prompt += `Важные заметки:\n`;
        facts.notes.forEach((n, i) => { prompt += `${i + 1}. ${n}\n`; });
    }
    prompt += `\nЕсли узнаёшь что-то важное — используй инструмент save_fact.\n`;
    return prompt;
}

// === АВТОСУММАРИЗАЦИЯ ===
async function summarizeOldMessages(memory) {
    try {
        const oldPart = memory.slice(0, SUMMARY_CHUNK);
        const dialogText = oldPart
            .map(m => `${m.role === 'user' ? 'Игорь' : 'Атлас'}: ${m.content}`)
            .join('\n');

        const facts = loadFacts();
        const prompt = `Сожми этот фрагмент диалога в 1-2 предложения. Сохрани только суть: темы, решения, важные выводы. Без воды.

Старое резюме (если есть): ${facts.summary || '(пусто)'}

Новый фрагмент диалога:
${dialogText}

Верни только новое объединённое резюме, без пояснений:`;

        const r = await fetch(API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${API_KEY}` },
            body: JSON.stringify({
                model: "deepseek-chat",
                messages: [{ role: "user", content: prompt }]
            })
        });
        const data = await r.json();
        if (data.error) {
            console.log("⚠️ Ошибка суммаризации:", data.error.message);
            return memory;
        }

        const newSummary = data.choices[0].message.content.trim();
        facts.summary = newSummary;
        saveFacts(facts);

        const newMemory = memory.slice(SUMMARY_CHUNK);
        saveMemory(newMemory);
        console.log(`📝 Суммаризация: сжато ${SUMMARY_CHUNK} сообщений. Резюме обновлено.`);
        return newMemory;
    } catch (e) {
        console.log("⚠️ Ошибка суммаризации:", e.message);
        return memory;
    }
}

// === ИНСТРУМЕНТЫ ===
const tools = [
    { type: "function", function: { name: "read_file", description: "Читает файл", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
    { type: "function", function: { name: "write_file", description: "Записывает текст в файл", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
    { type: "function", function: { name: "list_files", description: "Список файлов в папке", parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "run_command", description: "Запускает команду в терминале", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
    { type: "function", function: { name: "search_web", description: "Ищет в интернете через DuckDuckGo", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
    { type: "function", function: { name: "save_fact", description: "Сохраняет важный факт о пользователе в долговременную память. Используй, когда узнаёшь что-то, что стоит помнить надолго (проекты, цели, предпочтения).", parameters: { type: "object", properties: { fact: { type: "string", description: "Факт одним предложением" } }, required: ["fact"] } } }
];

async function executeTool(name, args) {
    try {
        if (name === "read_file") {
            const p = path.join(__dirname, args.path);
            return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : `Ошибка: файл ${args.path} не найден.`;
        }
        if (name === "write_file") {
            fs.writeFileSync(path.join(__dirname, args.path), args.content);
            return `Успех: ${args.path} записан.`;
        }
        if (name === "list_files") return fs.readdirSync(__dirname).join('\n');

        if (name === "run_command") {
            const cmd = args.command.trim();
            const first = cmd.split(' ')[0].toLowerCase();
            if (!CMD_WHITELIST.includes(first)) return `Отказ: команда "${first}" не разрешена.`;
            return await new Promise((resolve) => {
                exec(cmd, { timeout: 30000, cwd: __dirname }, (err, stdout, stderr) => {
                    if (err && !stdout) resolve(`Ошибка: ${stderr || err.message}`);
                    else resolve(`${stdout}\n${stderr || ''}`.trim() || 'Готово без вывода.');
                });
            });
        }

        if (name === "search_web") {
            const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`, {
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            const html = await res.text();
            const $ = cheerio.load(html);
            const results = [];
            $('a.result__a').each((i, el) => {
                if (i >= 5) return false;
                const title = $(el).text().trim();
                const url = $(el).attr('href');
                const snippet = $(el).closest('.result').find('.result__snippet').text().trim();
                if (title && url) results.push(`${i + 1}. ${title}\n   ${url}\n   ${snippet}`);
            });
            return results.length ? results.join('\n\n') : 'Ничего не найдено.';
        }

        if (name === "save_fact") {
            const facts = loadFacts();
            facts.notes.push(args.fact);
            saveFacts(facts);
            return `Факт сохранён: "${args.fact}"`;
        }

        return `Ошибка: инструмент ${name} неизвестен.`;
    } catch (e) { return `Ошибка: ${e.message}`; }
}

// === ПАМЯТЬ ===
function loadMemory() {
    if (fs.existsSync(MEMORY_FILE)) return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
    return [];
}
function saveMemory(m) { fs.writeFileSync(MEMORY_FILE, JSON.stringify(m, null, 2)); }

function buildMessages(dialog) {
    const facts = loadFacts();
    const systemPrompt = `Ты — Атлас, персональный ИИ-агент Игоря. Ты ДУМАЕШЬ.

Формат ответа: [Думаю]... [План]... [Делаю]... [Итог]...
Инструменты: read_file, write_file, list_files, run_command, search_web, save_fact.
Используй их САМ, когда нужно.${factsToPrompt(facts)}`;

    const recent = dialog.slice(-MAX_HISTORY);
    return [{ role: "system", content: systemPrompt }, ...recent];
}

// === СЕРВЕР ===
const server = http.createServer(async (req, res) => {

    if (req.method === 'POST' && req.url === '/clear-memory') {
        if (fs.existsSync(MEMORY_FILE)) fs.unlinkSync(MEMORY_FILE);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    if (req.method === 'GET' && req.url === '/') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(data);
        });
        return;
    }

    if (req.method === 'POST' && req.url === '/chat') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { message } = JSON.parse(body);
                let memory = loadMemory();
                memory.push({ role: "user", content: message });

                if (message.startsWith('/')) {
                    const [cmd, ...rest] = message.split(' ');
                    const arg = rest.join(' ');
                    let result = '';
                    if (cmd === '/read') result = await executeTool('read_file', { path: arg });
                    else if (cmd === '/write') { const [f, ...t] = rest; result = await executeTool('write_file', { path: f, content: t.join(' ') }); }
                    else if (cmd === '/list') result = await executeTool('list_files', {});
                    else if (cmd === '/cmd') result = await executeTool('run_command', { command: arg });
                    else if (cmd === '/web') result = await executeTool('search_web', { query: arg });
                    else if (cmd === '/fact') result = await executeTool('save_fact', { fact: arg });
                    else result = 'Неизвестная команда. Есть: /read /write /list /cmd /web /fact';
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ reply: `[ТЕСТ]\n${result}` }));
                    return;
                }

                const messages = buildMessages(memory);

                const r = await fetch(API_URL, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${API_KEY}` },
                    body: JSON.stringify({ model: "deepseek-chat", messages, tools })
                });
                const data = await r.json();
                if (data.error) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ reply: `Ошибка API: ${data.error.message}` }));
                    return;
                }

                const aiMsg = data.choices[0].message;

                if (aiMsg.tool_calls) {
                    memory.push(aiMsg);
                    for (const tc of aiMsg.tool_calls) {
                        const fnResult = await executeTool(tc.function.name, JSON.parse(tc.function.arguments));
                        memory.push({ role: "tool", tool_call_id: tc.id, content: fnResult });
                    }
                    const messages2 = buildMessages(memory);
                    const r2 = await fetch(API_URL, {
                        method: "POST",
                        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${API_KEY}` },
                        body: JSON.stringify({ model: "deepseek-chat", messages: messages2 })
                    });
                    const d2 = await r2.json();
                    const reply = d2.choices[0].message.content;
                    memory.push({ role: "assistant", content: reply });
                } else {
                    memory.push({ role: "assistant", content: aiMsg.content });
                }

                saveMemory(memory);

                // АВТОСУММАРИЗАЦИЯ
                if (memory.length > SUMMARY_TRIGGER) {
                    memory = await summarizeOldMessages(memory);
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ reply: memory[memory.length - 1].content }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ reply: "Ошибка сервера: " + e.message }));
            }
        });
        return;
    }
    res.writeHead(404); res.end();
});

server.listen(PORT, () => {
    console.log(`\n=========================================`);
    console.log(`   Атлас v3.1 (умная память) запущен!`);
    console.log(`   Автосуммаризация включена.`);
    console.log(`   👉 http://localhost:${PORT} 👈`);
    console.log(`=========================================\n`);
});