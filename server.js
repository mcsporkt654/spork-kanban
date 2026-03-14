require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const PORT = 3456;
const DATA_FILE = path.join(__dirname, 'data', 'tasks.json');
const LOG_FILE = path.join(__dirname, 'data', 'activity.json');

const TG_TOKEN = process.env.TG_TOKEN || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Data helpers ──────────────────────────────────────────────────────────────

function readData() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function readLog() {
  if (!fs.existsSync(LOG_FILE)) return [];
  return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
}

function appendLog(entry) {
  const log = readLog();
  log.unshift({ ...entry, ts: new Date().toISOString() });
  fs.writeFileSync(LOG_FILE, JSON.stringify(log.slice(0, 200), null, 2)); // keep last 200
}

// ── Telegram helper ───────────────────────────────────────────────────────────

function sendTelegram(text) {
  const body = JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'Markdown' });
  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${TG_TOKEN}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  });
  req.write(body);
  req.end();
}

const STATUS_LABELS = {
  backlog: '📋 Backlog',
  inprogress: '🔵 In Progress',
  inreview: '🟡 In Review',
  blocked: '🔴 Blocked',
  done: '✅ Done'
};

// ── Routes ────────────────────────────────────────────────────────────────────

// GET all tasks + log
app.get('/api/tasks', (req, res) => res.json(readData()));
app.get('/api/activity', (req, res) => res.json(readLog()));

// POST new task
app.post('/api/tasks', (req, res) => {
  const data = readData();
  const task = {
    id: 'task-' + Date.now(),
    title: req.body.title,
    description: req.body.description || '',
    status: req.body.status || 'backlog',
    project: req.body.project || 'General',
    priority: req.body.priority || 'normal',
    dueDate: req.body.dueDate || null,
    githubUrl: req.body.githubUrl || '',
    waitingOnConner: req.body.waitingOnConner || false,
    comments: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    notes: req.body.notes || ''
  };
  data.tasks.push(task);
  writeData(data);
  appendLog({ type: 'created', taskId: task.id, title: task.title, project: task.project, by: req.body.by || 'Conner' });
  res.json(task);
});

// PATCH task
app.patch('/api/tasks/:id', (req, res) => {
  const data = readData();
  const idx = data.tasks.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  const old = data.tasks[idx];
  const updated = { ...old, ...req.body, updatedAt: new Date().toISOString() };
  // preserve comments array — never overwrite via patch unless explicitly included
  if (!req.body.comments) updated.comments = old.comments || [];
  data.tasks[idx] = updated;
  writeData(data);

  // Log status change
  if (req.body.status && req.body.status !== old.status) {
    const from = STATUS_LABELS[old.status] || old.status;
    const to = STATUS_LABELS[req.body.status] || req.body.status;
    const by = req.body._by || 'Spork';
    appendLog({ type: 'moved', taskId: updated.id, title: updated.title, project: updated.project, from, to, by });
    sendTelegram(`⚡ *Kanban Update*\n*${updated.title}*\n${from} → ${to}\n_Project: ${updated.project}_`);
  }

  // Log waitingOnConner toggle
  if (req.body.waitingOnConner !== undefined && req.body.waitingOnConner !== old.waitingOnConner) {
    if (req.body.waitingOnConner) {
      appendLog({ type: 'waiting', taskId: updated.id, title: updated.title, project: updated.project });
      sendTelegram(`👋 *Waiting on you, Conner*\n*${updated.title}*\n_Project: ${updated.project}_\nSpork needs your input to continue.`);
    }
  }

  res.json(data.tasks[idx]);
});

// DELETE task
app.delete('/api/tasks/:id', (req, res) => {
  const data = readData();
  const task = data.tasks.find(t => t.id === req.params.id);
  data.tasks = data.tasks.filter(t => t.id !== req.params.id);
  writeData(data);
  if (task) appendLog({ type: 'deleted', taskId: task.id, title: task.title, project: task.project, by: 'Conner' });
  res.json({ ok: true });
});

// POST comment on a task
app.post('/api/tasks/:id/comments', (req, res) => {
  const data = readData();
  const idx = data.tasks.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const comment = {
    id: 'c-' + Date.now(),
    author: req.body.author || 'Conner',
    text: req.body.text,
    ts: new Date().toISOString()
  };
  if (!data.tasks[idx].comments) data.tasks[idx].comments = [];
  data.tasks[idx].comments.push(comment);
  data.tasks[idx].updatedAt = new Date().toISOString();
  writeData(data);
  appendLog({ type: 'comment', taskId: data.tasks[idx].id, title: data.tasks[idx].title, project: data.tasks[idx].project, author: comment.author, text: comment.text });
  res.json(comment);
});

// GET projects
app.get('/api/projects', (req, res) => res.json(readData().projects));

// POST new project
app.post('/api/projects', (req, res) => {
  const data = readData();
  const name = req.body.name;
  if (!name || data.projects.includes(name)) return res.status(400).json({ error: 'Invalid or duplicate' });
  data.projects.push(name);
  writeData(data);
  res.json(data.projects);
});

app.listen(PORT, '0.0.0.0', () => console.log(`Spork Kanban running on http://0.0.0.0:${PORT}`));
