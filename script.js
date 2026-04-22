const API_URL = 'https://jsonplaceholder.typicode.com/todos';
const STORAGE_KEY = 'todo_tasks';

let tasks = [];
let currentFilter = 'all';
const reminderTimers = new Map();

let taskListEl, emptyStateEl, emptyMsgEl;

const FILTER_CONFIG = {
  all:       { predicate: () => true,        emptyMsg: 'No tasks yet! Add your first one above.' },
  completed: { predicate: t => t.completed,  emptyMsg: 'No completed tasks yet.' },
  pending:   { predicate: t => !t.completed, emptyMsg: 'All tasks done! Great job. 🎉' },
};

// ─── Init ──────────────────────────────────────────────────

async function init() {
  taskListEl   = document.getElementById('taskList');
  emptyStateEl = document.getElementById('emptyState');
  emptyMsgEl   = document.getElementById('emptyMessage');

  // Show loading immediately — before any async work
  if (!localStorage.getItem(STORAGE_KEY)) {
    showLoadingState();
  }

  await ensureNotificationPermission();
  await loadTasks();
  renderTasks();
  setupEventListeners();
}

// ─── Notifications ─────────────────────────────────────────

async function ensureNotificationPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'default') {
    const result = await Notification.requestPermission();
    return result === 'granted';
  }
  return false;
}

// ─── Data: load / save ─────────────────────────────────────

async function loadTasks() {
  const stored = localStorage.getItem(STORAGE_KEY);

  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      tasks = Array.isArray(parsed)
        ? parsed.filter(t =>
            typeof t.id === 'number' &&
            typeof t.text === 'string' &&
            typeof t.completed === 'boolean'
          )
        : [];
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
    return;
  }

  try {
    const response = await fetch(`${API_URL}?_limit=15`);
    if (!response.ok) throw new Error(`API error: ${response.status}`);
    const data = await response.json();

    tasks = data.map(todo => ({
      id: todo.id,
      text: todo.title,
      completed: todo.completed,
    }));

    saveTasks();
  } catch {
    tasks = [];
  }
}

function saveTasks() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
}

// ─── Render ────────────────────────────────────────────────

function showLoadingState() {
  const loading = document.createElement('p');
  loading.className = 'loading-text';
  loading.textContent = 'Loading tasks...';
  taskListEl.appendChild(loading);
}

// Full re-render — only for filter changes and initial load (no animation)
function renderTasks() {
  const { predicate, emptyMsg } = FILTER_CONFIG[currentFilter];
  const filtered = tasks.filter(predicate);

  taskListEl.innerHTML = '';

  if (filtered.length === 0) {
    emptyMsgEl.textContent = emptyMsg;
    emptyStateEl.classList.remove('hidden');
    return;
  }

  emptyStateEl.classList.add('hidden');
  filtered.forEach(task => taskListEl.appendChild(createTaskElement(task)));
}

// Show empty state if list is now empty after a removal
function checkEmptyState() {
  if (taskListEl.children.length === 0) {
    emptyMsgEl.textContent = FILTER_CONFIG[currentFilter].emptyMsg;
    emptyStateEl.classList.remove('hidden');
  }
}

function createTaskElement(task, isNew = false) {
  const item = document.createElement('div');
  item.classList.add('task-item', 'glass');
  if (task.completed) item.classList.add('completed');
  if (isNew) item.classList.add('is-new');
  item.dataset.id = String(task.id);

  // Structure via innerHTML; user text is set via textContent below (XSS-safe)
  item.innerHTML = `
    <input type="checkbox" class="custom-checkbox" ${task.completed ? 'checked' : ''} aria-label="Toggle task completion" />
    <span class="task-text"></span>
    <div class="task-actions">
      <button class="btn-icon btn-reminder" title="Set reminder" aria-label="Set reminder">🔔</button>
      <button class="btn-icon btn-delete" title="Delete task" aria-label="Delete task">🗑️</button>
    </div>
  `;

  item.querySelector('.task-text').textContent = task.text;

  // Clicking anywhere on the card toggles the task (except buttons and the checkbox itself)
  item.addEventListener('click', (e) => {
    if (e.target.closest('.task-actions') || e.target.classList.contains('custom-checkbox')) return;
    toggleTask(task.id);
  });

  item.querySelector('.custom-checkbox').addEventListener('change', () => toggleTask(task.id));
  item.querySelector('.btn-reminder').addEventListener('click', () => setReminder(task.id, task.text));
  item.querySelector('.btn-delete').addEventListener('click', () => deleteTask(task.id));

  return item;
}

// ─── Task actions ──────────────────────────────────────────

function addTask() {
  const input = document.getElementById('taskInput');
  const text = input.value.trim();
  if (!text) return;

  const newTask = { id: Date.now(), text, completed: false };
  tasks.unshift(newTask);
  saveTasks();
  input.value = '';

  // New tasks are always pending — switch to 'all' if current filter would hide them
  if (!FILTER_CONFIG[currentFilter].predicate(newTask)) {
    setFilter('all');
    return;
  }

  emptyStateEl.classList.add('hidden');
  taskListEl.prepend(createTaskElement(newTask, true));
}

function toggleTask(id) {
  const task = tasks.find(t => t.id === id);
  if (!task) return;

  task.completed = !task.completed;
  saveTasks();

  const item = taskListEl.querySelector(`[data-id="${id}"]`);
  if (!item) return;

  if (FILTER_CONFIG[currentFilter].predicate(task)) {
    // Still matches filter — update in place, no re-render, no flicker
    item.classList.toggle('completed', task.completed);
    item.querySelector('.custom-checkbox').checked = task.completed;
  } else {
    // No longer matches active filter — remove from view
    item.remove();
    checkEmptyState();
  }
}

function deleteTask(id) {
  clearTimeout(reminderTimers.get(id));
  reminderTimers.delete(id);

  tasks = tasks.filter(t => t.id !== id);
  saveTasks();

  taskListEl.querySelector(`[data-id="${id}"]`)?.remove();
  checkEmptyState();
}

// ─── Reminder ──────────────────────────────────────────────

async function setReminder(id, taskText) {
  const safeLabel = taskText.length > 80 ? taskText.slice(0, 80) + '…' : taskText;
  const input = prompt(`Через сколько минут напомнить?\n\n"${safeLabel}"`);
  if (input === null) return;

  const minutes = parseInt(input, 10);
  if (isNaN(minutes) || minutes <= 0 || minutes > 1440) {
    alert('Введите число минут от 1 до 1440.');
    return;
  }

  const granted = await ensureNotificationPermission();
  if (!granted) {
    alert(!('Notification' in window)
      ? 'Ваш браузер не поддерживает уведомления.'
      : 'Уведомления отключены. Разрешите их в настройках браузера.'
    );
    return;
  }

  clearTimeout(reminderTimers.get(id));
  const timerId = setTimeout(() => {
    new Notification('To-Do Reminder', { body: taskText });
    reminderTimers.delete(id);
  }, minutes * 60 * 1000);
  reminderTimers.set(id, timerId);

  alert(`Напоминание установлено через ${minutes} мин.`);
}

// ─── Filter ────────────────────────────────────────────────

function setFilter(filter) {
  currentFilter = filter;

  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });

  renderTasks();
}

// ─── Event listeners ───────────────────────────────────────

function setupEventListeners() {
  document.getElementById('addBtn').addEventListener('click', addTask);

  document.getElementById('taskInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') addTask();
  });

  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => setFilter(btn.dataset.filter));
  });
}

// ─── Start ─────────────────────────────────────────────────

init();
