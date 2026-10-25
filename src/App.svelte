<script>
  import { onMount, tick } from 'svelte';
  import { supabase, taskFromRow, taskToRow } from './lib/supabase.js';

  const storageKey = 'daylist-tasks-v1';
  const noteColors = ['yellow', 'mint', 'rose', 'peach', 'sky', 'lilac'];
  const workspaceThemes = [
    { id: 'sage', name: 'Sage', preview: '#78967b' },
    { id: 'ocean', name: 'Ocean', preview: '#6489ad' },
    { id: 'lavender', name: 'Lavender', preview: '#8a78ad' },
    { id: 'coral', name: 'Coral', preview: '#c77c6d' },
    { id: 'amber', name: 'Amber', preview: '#b08a46' },
  ];
  const themeStorageKey = 'daylist-workspace-theme-v1';
  const weekdays = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  const hours = Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, '0'));
  const minutes = Array.from({ length: 60 }, (_, index) => String(index).padStart(2, '0'));
  let tasks = $state([]);
  let filter = $state('today');
  let searchQuery = $state('');
  let colorFilter = $state('');
  let selectedTaskId = $state('');
  let theme = $state('sage');
  let themePickerOpen = $state(false);
  let modalOpen = $state(false);
  let modalTitle = $state('');
  let modalNotes = $state('');
  let modalDue = $state('');
  let modalColor = $state('yellow');
  let datePickerOpen = $state(false);
  let calendarMonth = $state(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  let timeHour = $state('09');
  let timeMinute = $state('00');
  let timePeriod = $state('AM');
  let editingTaskId = $state(null);
  let titleInput = $state(null);
  let paperDialog = $state(null);
  let modalReturnFocus = $state(null);
  let ready = $state(false);
  let localOnly = $state(false);
  let reminderPermission = $state('unsupported');
  let reminderQueue = $state([]);
  let currentTime = $state(Date.now());
  let authUser = $state(null);
  let authError = $state('');
  let authSubscription;
  let activeUserId = null;

  function readLegacyTasks() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || '[]');
      if (!Array.isArray(saved)) return [];
      return saved.filter((task) => task && typeof task.id === 'string' && typeof task.title === 'string')
        .map((task) => ({
          id: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(task.id) ? task.id : crypto.randomUUID(),
          title: task.title.trim().slice(0, 160),
          done: Boolean(task.done),
          createdAt: Number.isFinite(Number(task.createdAt)) && Number(task.createdAt) > 0 ? Number(task.createdAt) : Date.now(),
          dueAt: typeof task.dueAt === 'string' && Number.isFinite(new Date(task.dueAt).getTime()) ? task.dueAt : '',
          reminded: Boolean(task.reminded),
          notes: typeof task.notes === 'string' ? task.notes : '',
          color: noteColors.includes(task.color) ? task.color : '',
        })).filter((task) => task.title);
    } catch {
      return [];
    }
  }

  async function loadUserTasks(user) {
    if (!supabase || !user) return;
    activeUserId = user.id;
    ready = false;
    reminderQueue = [];
    const { data, error } = await supabase.from('tasks').select('*').order('created_at', { ascending: false });
    if (activeUserId !== user.id) return;
    if (error) {
      authError = `Cloud sync is unavailable: ${error.message}`;
      localOnly = true;
      tasks = readLegacyTasks();
      ready = true;
      return;
    }
    localOnly = false;
    let rows = data ?? [];
    const legacyTasks = readLegacyTasks();
    if (legacyTasks.length) {
      const { data: imported, error: importError } = await supabase.from('tasks')
        .upsert(legacyTasks.map((task) => taskToRow(task, user.id))).select('*');
      if (activeUserId !== user.id) return;
      if (importError) authError = `Tasks loaded, but browser-saved tasks could not be imported: ${importError.message}`;
      else {
        const importedIds = new Set((imported ?? []).map((task) => task.id));
        rows = [...rows.filter((task) => !importedIds.has(task.id)), ...(imported ?? [])];
        try { localStorage.removeItem(storageKey); } catch { /* Imported tasks are safely stored remotely. */ }
      }
    }
    tasks = rows.map(taskFromRow);
    ready = true;
    currentTime = Date.now();
    checkReminders();
  }

  onMount(async () => {
    tasks = readLegacyTasks();
    localOnly = true;
    ready = true;
    try {
      const savedTheme = localStorage.getItem(themeStorageKey);
      if (workspaceThemes.some((option) => option.id === savedTheme)) theme = savedTheme;
    } catch { /* Theme preferences may be unavailable in private browsing. */ }
    if ('Notification' in window) reminderPermission = Notification.permission;
    if (supabase) {
      try {
        const { data, error } = await supabase.auth.getSession();
        if (error) throw error;
        authUser = data.session?.user ?? null;
      } catch { authUser = null; }
      if (!authUser) {
        try {
          const { data, error } = await supabase.auth.signInAnonymously();
          if (error) throw error;
          authUser = data.user;
        } catch { localOnly = true; }
      }
      if (authUser) await loadUserTasks(authUser);
      else { tasks = readLegacyTasks(); ready = true; }
      const { data } = supabase.auth.onAuthStateChange((_event, session) => {
        const nextUser = session?.user ?? null;
        authUser = nextUser;
        if (nextUser) { authError = ''; localOnly = false; void loadUserTasks(nextUser); }
        else { activeUserId = null; localOnly = true; tasks = readLegacyTasks(); ready = true; reminderQueue = []; }
      });
      authSubscription = data.subscription;
    } else {
      localOnly = true;
      tasks = readLegacyTasks();
      ready = true;
    }
    const timer = window.setInterval(() => {
      currentTime = Date.now();
      checkReminders();
    }, 15000);
    return () => { window.clearInterval(timer); authSubscription?.unsubscribe(); };
  });

  $effect(() => {
    if (ready && localOnly) {
      try { localStorage.setItem(storageKey, JSON.stringify(tasks)); } catch { /* Local storage may be unavailable. */ }
    }
  });

  $effect(() => {
    if (ready) {
      try { localStorage.setItem(themeStorageKey, theme); } catch { /* Theme preferences may be unavailable. */ }
    }
  });

  let selectedTheme = $derived(workspaceThemes.find((option) => option.id === theme) ?? workspaceThemes[0]);

  let todayLabel = $derived(new Intl.DateTimeFormat('en', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date()));
  let remaining = $derived(tasks.filter((task) => !task.done).length);
  let completed = $derived(tasks.filter((task) => task.done).length);
  let visibleTasks = $derived(tasks.filter((task) => {
    const matchesFilter = (filter === 'wall' && !task.done)
      || (filter === 'today' && !task.done && !isUpcoming(task) && !isMissed(task))
      || (filter === 'upcoming' && isUpcoming(task))
      || (filter === 'calendar' && !task.done && Boolean(task.dueAt))
      || (filter === 'missed' && isMissed(task))
      || (filter === 'completed' && task.done);
    const matchesColor = !colorFilter || noteColor(task, tasks.indexOf(task)) === colorFilter;
    return matchesFilter && matchesColor && task.title.toLowerCase().includes(searchQuery.trim().toLowerCase());
  }));
  let selectedTask = $derived(visibleTasks.find((task) => task.id === selectedTaskId) ?? visibleTasks[0] ?? null);
  let viewTitle = $derived(filter === 'today' ? 'Today' : filter === 'upcoming' ? 'Upcoming' : filter === 'calendar' ? 'Calendar' : filter === 'missed' ? 'Missed' : filter === 'completed' ? 'Completed' : 'Sticky Wall');
  let upcomingCount = $derived(tasks.filter(isUpcoming).length);
  let todayCount = $derived(tasks.filter((task) => !task.done && !isUpcoming(task) && !isMissed(task)).length);
  let missedCount = $derived(tasks.filter(isMissed).length);
  let calendarMonthLabel = $derived(new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric' }).format(calendarMonth));
  let calendarDays = $derived(makeCalendarDays(calendarMonth));

  async function persistTask(task) {
    if (localOnly) return true;
    if (!supabase || !activeUserId) return false;
    const { error } = await supabase.from('tasks').upsert(taskToRow(task, activeUserId));
    if (error) { authError = `Could not save task: ${error.message}`; return false; }
    authError = '';
    return true;
  }

  async function saveNote(event) {
    event.preventDefault();
    const title = modalTitle.trim();
    if (!title) return;
    const previousTask = editingTaskId ? tasks.find((item) => item.id === editingTaskId) : null;
    const task = editingTaskId
      ? { ...previousTask, title, notes: modalNotes, dueAt: modalDue, color: modalColor, reminded: previousTask?.dueAt === modalDue ? previousTask.reminded : false }
      : { id: crypto.randomUUID(), title, done: false, createdAt: Date.now(), dueAt: modalDue, reminded: false, notes: modalNotes, color: modalColor };
    if (!task || !await persistTask(task)) return;
    if (editingTaskId) {
      tasks = tasks.map((item) => item.id === editingTaskId ? task : item);
    } else {
      tasks = [task, ...tasks];
    }
    filter = 'wall';
    closeEditor();
  }

  async function openCreateNote(event) {
    modalReturnFocus = event?.currentTarget;
    editingTaskId = null;
    modalTitle = '';
    modalNotes = '';
    modalDue = '';
    modalColor = 'yellow';
    datePickerOpen = false;
    calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    timeHour = '09';
    timeMinute = '00';
    timePeriod = 'AM';
    modalOpen = true;
    await tick();
    if (paperDialog && !paperDialog.open) paperDialog.showModal();
    titleInput?.focus();
  }

  async function openEditNote(task, event) {
    modalReturnFocus = event?.currentTarget;
    editingTaskId = task.id;
    modalTitle = task.title;
    modalNotes = task.notes;
    modalDue = task.dueAt;
    modalColor = task.color || 'yellow';
    datePickerOpen = false;
    const date = task.dueAt ? new Date(task.dueAt) : new Date();
    calendarMonth = new Date(date.getFullYear(), date.getMonth(), 1);
    const hour = date.getHours();
    timeHour = String(hour % 12 || 12).padStart(2, '0');
    timeMinute = String(date.getMinutes()).padStart(2, '0');
    timePeriod = hour >= 12 ? 'PM' : 'AM';
    modalOpen = true;
    await tick();
    if (paperDialog && !paperDialog.open) paperDialog.showModal();
    titleInput?.focus();
  }

  function closeEditor() {
    if (paperDialog?.open) paperDialog.close();
    modalOpen = false;
    datePickerOpen = false;
    editingTaskId = null;
    requestAnimationFrame(() => modalReturnFocus?.focus());
  }

  function handleWindowKeydown(event) {
    if (modalOpen && event.key === 'Escape') {
      event.preventDefault();
      closeEditor();
    } else if (reminderQueue.length && event.key === 'Escape') {
      event.preventDefault();
      dismissReminder();
    }
  }

  function noteColor(task, index) {
    return task.color || noteColors[index % noteColors.length];
  }

  function localDateString(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function makeCalendarDays(month) {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const start = new Date(month.getFullYear(), month.getMonth(), 1 - first.getDay());
    const selectedDate = modalDue ? modalDue.split('T')[0] : '';
    const today = localDateString(new Date());
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
      const value = localDateString(date);
      return { value, day: date.getDate(), inMonth: date.getMonth() === month.getMonth(), selected: value === selectedDate, today: value === today };
    });
  }

  function setCalendarMonth(offset) {
    calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + offset, 1);
  }

  function to24Hour() {
    const hour = Number(timeHour) % 12 + (timePeriod === 'PM' ? 12 : 0);
    return String(hour).padStart(2, '0');
  }

  function setPickerDate(value) {
    modalDue = `${value}T${to24Hour()}:${timeMinute}`;
    const date = new Date(`${value}T12:00`);
    calendarMonth = new Date(date.getFullYear(), date.getMonth(), 1);
  }

  function updatePickerTime(part, value) {
    if (part === 'hour') timeHour = value;
    if (part === 'minute') timeMinute = value;
    if (part === 'period') timePeriod = value;
    if (modalDue) modalDue = `${modalDue.split('T')[0]}T${to24Hour()}:${timeMinute}`;
  }

  function setQuickDate(offset) {
    const date = new Date();
    date.setDate(date.getDate() + offset);
    setPickerDate(localDateString(date));
  }

  function clearPickerDate() {
    modalDue = '';
  }

  function isUpcoming(task) {
    if (task.done || !task.dueAt) return false;
    const due = new Date(task.dueAt);
    const tomorrow = new Date();
    tomorrow.setHours(24, 0, 0, 0);
    return due.getTime() >= tomorrow.getTime();
  }

  function isMissed(task) {
    if (task.done || !task.dueAt) return false;
    const due = new Date(task.dueAt);
    const gracePeriod = 5 * 60 * 1000;
    return Number.isFinite(due.getTime()) && due.getTime() + gracePeriod <= currentTime;
  }

  async function toggleTask(id) {
    const task = tasks.find((item) => item.id === id);
    if (!task || !await persistTask({ ...task, done: !task.done })) return;
    tasks = tasks.map((item) => item.id === id ? { ...item, done: !item.done } : item);
  }

  async function deleteTask(id) {
    if (!localOnly) {
      if (!supabase || !activeUserId) return;
      const { error } = await supabase.from('tasks').delete().eq('id', id);
      if (error) { authError = `Could not delete task: ${error.message}`; return; }
      authError = '';
    }
    tasks = tasks.filter((task) => task.id !== id);
    reminderQueue = reminderQueue.filter((task) => task.id !== id);
    if (editingTaskId === id) closeEditor();
  }

  function dismissReminder() {
    reminderQueue = reminderQueue.slice(1);
  }

  function completeReminder() {
    const current = reminderQueue[0];
    if (!current) return;
    toggleTask(current.id);
    dismissReminder();
  }

  async function snoozeReminder() {
    const current = reminderQueue[0];
    if (!current) return;
    const snoozedUntil = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    if (!await persistTask({ ...current, dueAt: snoozedUntil, reminded: false })) return;
    tasks = tasks.map((task) => task.id === current.id ? { ...task, dueAt: snoozedUntil, reminded: false } : task);
    dismissReminder();
  }

  async function enableReminders() {
    if (!('Notification' in window)) { reminderPermission = 'unsupported'; return; }
    try {
      reminderPermission = await Notification.requestPermission();
      checkReminders();
    } catch {
      reminderPermission = Notification.permission;
    }
  }

  function checkReminders() {
    if (!ready) return;
    const now = Date.now();
    const dueNow = tasks.filter((task) => !task.done && !task.reminded && task.dueAt && Number.isFinite(new Date(task.dueAt).getTime()) && new Date(task.dueAt).getTime() <= now);
    if (!dueNow.length) return;
    const ids = new Set(dueNow.map((task) => task.id));
    tasks = tasks.map((task) => ids.has(task.id) ? { ...task, reminded: true } : task);
    reminderQueue = [...reminderQueue, ...dueNow];
    if (supabase && activeUserId && !localOnly) void supabase.from('tasks').update({ reminded: true }).in('id', [...ids]);
    if (reminderPermission === 'granted' && 'Notification' in window) {
      dueNow.forEach((task) => {
        const notification = new Notification('Task due now', { body: task.title, tag: `daylist-${task.id}` });
        notification.onclick = () => { window.focus(); notification.close(); };
      });
    }
  }

  function formatDue(dueAt) {
    const date = new Date(dueAt);
    return `${new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(date)} · ${new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(date)}`;
  }
</script>

<svelte:head>
  <title>Jireh Todolist</title>
</svelte:head>

<svelte:window onkeydown={handleWindowKeydown} />

<div class="page-backdrop theme-{theme}">
  <div class="app-shell redesign-shell">
    <aside class="redesign-sidebar">
      <div class="redesign-side-head"><a class="redesign-brand" href="#home"><span class="brand-symbol">J</span><span>Jireh Todolist</span></a><span class="redesign-menu-label">Menu</span><span class="redesign-menu-mark">☰</span></div>
      <label class="redesign-search"><span>⌕</span><input aria-label="Search tasks" bind:value={searchQuery} placeholder="Search tasks" /></label>

      <div class="redesign-group-label">TASKS</div>
      <nav class="redesign-nav" aria-label="Task views">
        <button class="redesign-nav-item" class:active={filter === 'upcoming'} onclick={() => { filter = 'upcoming'; colorFilter = ''; }}><span>↗</span><span>Upcoming</span><b>{upcomingCount}</b></button>
        <button class="redesign-nav-item" class:active={filter === 'today'} onclick={() => { filter = 'today'; colorFilter = ''; }}><span>▦</span><span>Today</span><b>{todayCount}</b></button>
        <button class="redesign-nav-item" class:active={filter === 'calendar'} onclick={() => { filter = 'calendar'; colorFilter = ''; }}><span>▣</span><span>Calendar</span><b>{tasks.filter((task) => !task.done && task.dueAt).length}</b></button>
        <button class="redesign-nav-item" class:active={filter === 'wall'} onclick={() => { filter = 'wall'; colorFilter = ''; }}><span>▤</span><span>Sticky Wall</span></button>
        <button class="redesign-nav-item" class:active={filter === 'missed'} onclick={() => { filter = 'missed'; colorFilter = ''; }}><span>!</span><span>Missed</span><b>{missedCount}</b></button>
        <button class="redesign-nav-item" class:active={filter === 'completed'} onclick={() => { filter = 'completed'; colorFilter = ''; }}><span>✓</span><span>Completed</span><b>{completed}</b></button>
      </nav>

      <div class="redesign-group-heading"><span class="redesign-group-label">LISTS</span><button aria-label="Add a list" title="Lists are coming soon" disabled>＋</button></div>
      <button class="redesign-list-item" class:active={filter === 'today'} onclick={() => { filter = 'today'; colorFilter = ''; }}><i></i><span>Personal</span><b>{todayCount}</b></button>
      <button class="redesign-list-item" class:active={filter === 'upcoming'} onclick={() => { filter = 'upcoming'; colorFilter = ''; }}><i class="list-dot-blue"></i><span>Upcoming</span><b>{upcomingCount}</b></button>

      <div class="redesign-group-heading color-heading"><span class="redesign-group-label">PAPER COLORS</span></div>
      <div class="redesign-color-tags">
        {#each noteColors as color}
          <button class:active={colorFilter === color} onclick={() => colorFilter = colorFilter === color ? '' : color} aria-pressed={colorFilter === color}>
            <i class="color-dot swatch-{color}"></i><span>{color[0].toUpperCase() + color.slice(1)}</span><b>{tasks.filter((task) => (task.color || 'yellow') === color).length}</b>
          </button>
        {/each}
      </div>

      <div class="redesign-sidebar-footer">
        <button class="redesign-footer-action" aria-expanded={themePickerOpen} aria-controls="workspace-theme-picker" onclick={() => themePickerOpen = !themePickerOpen}><span>⚙</span><span>Settings</span><span class="theme-preview" style={`--swatch: ${selectedTheme.preview}`}></span></button>
        {#if themePickerOpen}
          <div class="theme-picker redesign-theme-picker" id="workspace-theme-picker" role="group" aria-label="Choose workspace theme color">
            <span class="theme-picker-label">Workspace color</span>
            <div class="theme-swatches">
              {#each workspaceThemes as option}
                <button type="button" class="theme-swatch" class:active={theme === option.id} style={`--swatch: ${option.preview}`} aria-label={`Use ${option.name} theme`} aria-pressed={theme === option.id} title={option.name} onclick={() => theme = option.id}></button>
              {/each}
            </div><span class="theme-current">{selectedTheme.name}</span>
          </div>
        {/if}
        {#if localOnly}<div class="sync-indicator"><span></span>Saved on this device</div>{:else if authUser}<div class="sync-indicator synced"><span></span>Synced with Supabase</div>{/if}
      </div>
    </aside>

    <main id="home" class="redesign-main">
      <header class="redesign-topbar"><div class="redesign-breadcrumb">MY SPACE <span>/</span> <strong>{viewTitle.toUpperCase()}</strong></div><div class="redesign-top-actions"><span class="redesign-date">{todayLabel}</span>{#if reminderPermission === 'default'}<button class="redesign-reminder-button" onclick={enableReminders}>Enable reminders</button>{:else if reminderPermission === 'granted'}<span class="reminder-status enabled">◉ Reminders on</span>{/if}<span class="redesign-avatar">K</span></div></header>
      {#if authError}<div class="sync-alert redesign-alert" role="alert">{authError}</div>{/if}

      <div class="redesign-workspace">
        <section class="redesign-center" aria-label="Task list">
          <div class="redesign-page-heading"><div><p>{new Intl.DateTimeFormat('en', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date())}</p><h1>{viewTitle}<span>{visibleTasks.length}</span></h1></div><button class="redesign-primary-add" type="button" onclick={openCreateNote}><span>＋</span> Add task</button></div>

          {#if filter !== 'wall'}
            <div class="redesign-list-caption"><span>{filter === 'today' ? 'Today’s focus' : filter === 'upcoming' ? 'Coming up' : filter === 'calendar' ? 'Scheduled tasks' : filter === 'missed' ? 'Needs attention' : 'Finished tasks'}</span><span>{visibleTasks.length} {visibleTasks.length === 1 ? 'task' : 'tasks'}</span></div>
            <div class="redesign-task-list">
              <button class="redesign-add-row" type="button" onclick={openCreateNote}><span>＋</span> Add new task</button>
              {#if visibleTasks.length}
                {#each visibleTasks as task (task.id)}
                  <div class="redesign-task-row" class:selected={selectedTask?.id === task.id} class:completed-task={task.done}>
                    <button class="redesign-checkbox" class:checked={task.done} aria-label={task.done ? `Mark ${task.title} as to do` : `Complete ${task.title}`} onclick={() => toggleTask(task.id)}>{#if task.done}✓{/if}</button>
                    <button class="redesign-task-main" type="button" onclick={() => selectedTaskId = task.id}>
                      <span class="redesign-task-title">{task.title}</span>
                      {#if task.notes}<span class="redesign-task-summary">{task.notes}</span>{/if}
                      <span class="redesign-task-meta">{#if task.dueAt}<span>▦ {formatDue(task.dueAt)}</span>{/if}{#if task.notes}<span>▤ Details</span>{/if}<i class="color-dot swatch-{noteColor(task, 0)}"></i></span>
                    </button>
                    <button class="redesign-row-edit" type="button" aria-label={`Edit ${task.title}`} onclick={(event) => openEditNote(task, event)}>›</button>
                  </div>
                {/each}
              {:else}
                <div class="redesign-empty"><span>✳</span><strong>{searchQuery.trim() ? 'No matching tasks' : filter === 'today' ? 'A clear day, for now' : 'Nothing here yet'}</strong><p>{searchQuery.trim() ? 'Try a different search.' : 'Add a task whenever you’re ready.'}</p><button type="button" onclick={openCreateNote}>＋ Add a task</button></div>
              {/if}
            </div>
          {:else}
            <div class="redesign-sticky-grid">
              {#if visibleTasks.length}
                {#each visibleTasks as task, index (task.id)}
                  <article class="sticky-note redesign-sticky-note" class:note-yellow={noteColor(task, index) === 'yellow'} class:note-mint={noteColor(task, index) === 'mint'} class:note-rose={noteColor(task, index) === 'rose'} class:note-peach={noteColor(task, index) === 'peach'} class:note-sky={noteColor(task, index) === 'sky'} class:note-lilac={noteColor(task, index) === 'lilac'} class:done-note={task.done}>
                    <div class="note-topline"><button class="check-button" class:checked={task.done} aria-label={task.done ? `Mark ${task.title} as to do` : `Complete ${task.title}`} onclick={() => toggleTask(task.id)}>{#if task.done}✓{/if}</button><button class="note-edit" aria-label={`Edit ${task.title}`} onclick={(event) => openEditNote(task, event)}>✎</button></div>
                    <button class="note-title" onclick={() => selectedTaskId = task.id}>{task.title}</button><p class="note-body">{task.notes || 'Add details from the task panel.'}</p><div class="note-due">◷ <span>{task.dueAt ? formatDue(task.dueAt) : 'No due date'}</span></div>
                  </article>
                {/each}
              {:else}<div class="redesign-empty"><span>▤</span><strong>Your wall is clear</strong><p>Add a note to get started.</p><button type="button" onclick={openCreateNote}>＋ Add a task</button></div>{/if}
            </div>
          {/if}
        </section>

        <aside class="redesign-detail" aria-label="Task details">
          {#if selectedTask}
            <div class="redesign-detail-head"><span>TASK DETAILS</span><button type="button" aria-label="Edit task" onclick={(event) => openEditNote(selectedTask, event)}>✎</button></div>
            <div class="redesign-detail-title"><span class="detail-check" class:checked={selectedTask.done}>{selectedTask.done ? '✓' : ''}</span><h2>{selectedTask.title}</h2></div>
            <div class="redesign-detail-section"><span class="detail-section-label">DESCRIPTION</span><p class:muted={!selectedTask.notes}>{selectedTask.notes || 'Add a description to keep useful details with this task.'}</p></div>
            <div class="redesign-detail-fields"><div><span>List</span><strong><i class="list-dot"></i> Personal</strong></div><div><span>Due date</span><strong>{selectedTask.dueAt ? formatDue(selectedTask.dueAt) : 'Not set'}</strong></div><div><span>Paper</span><strong><i class="color-dot swatch-{noteColor(selectedTask, 0)}"></i>{noteColor(selectedTask, 0)}</strong></div><div><span>Status</span><strong>{selectedTask.done ? 'Completed' : 'To do'}</strong></div></div>
            <div class="redesign-detail-spacer"></div>
            <div class="redesign-detail-actions"><button type="button" class="detail-delete" onclick={() => deleteTask(selectedTask.id)}>Delete task</button><button type="button" class="detail-save" onclick={(event) => openEditNote(selectedTask, event)}>Edit task</button></div>
          {:else}
            <div class="redesign-detail-empty"><span>↖</span><strong>Select a task</strong><p>Choose a task to see its details here.</p></div>
          {/if}
        </aside>
      </div>
    </main>
  </div>
  {#if modalOpen}
    <div class="modal-backdrop">
      <dialog bind:this={paperDialog} class="paper-sheet paper-{modalColor}" aria-labelledby="paper-title" oncancel={(event) => { event.preventDefault(); closeEditor(); }}>
        <div class="paper-header"><span class="paper-kicker">DAYLIST <span>·</span> YOUR TASKS</span><button type="button" class="paper-close" aria-label="Close editor" onclick={closeEditor}>×</button></div>
        <h2 id="paper-title">{editingTaskId ? 'Edit your task' : 'A new task'}</h2>
        <form class="paper-form" onsubmit={saveNote}>
          <label class="paper-label" for="paper-task-title">WHAT DO YOU NEED TO DO?</label>
          <input id="paper-task-title" class="paper-title-input" bind:this={titleInput} bind:value={modalTitle} maxlength="160" placeholder="Write a task title..." required />

          <label class="paper-label" for="paper-task-notes">TASK DETAILS</label>
          <textarea id="paper-task-notes" class="paper-notes-input" bind:value={modalNotes} rows="5" placeholder="Add any notes or details here..."></textarea>

          <div class="paper-field-heading"><span class="paper-label">DATE & TIME</span><span class="optional-label">OPTIONAL</span></div>
          <div class="date-time-control">
            <button class="date-trigger" type="button" aria-expanded={datePickerOpen} onclick={() => datePickerOpen = !datePickerOpen}>
              <span class="date-trigger-icon">▦</span>
              <span class:date-placeholder={!modalDue}>{modalDue ? formatDue(modalDue) : 'Choose a date and time'}</span>
              <span class="date-trigger-chevron">{datePickerOpen ? '⌃' : '⌄'}</span>
            </button>
            {#if datePickerOpen}
              <div class="calendar-popover" aria-label="Choose due date and time">
                <div class="calendar-header">
                  <button type="button" aria-label="Previous month" onclick={() => setCalendarMonth(-1)}>‹</button>
                  <strong>{calendarMonthLabel}</strong>
                  <button type="button" aria-label="Next month" onclick={() => setCalendarMonth(1)}>›</button>
                </div>
                <div class="picker-layout">
                  <div class="calendar-section">
                    <div class="weekdays">{#each weekdays as day}<span>{day}</span>{/each}</div>
                    <div class="calendar-days">
                      {#each calendarDays as day (day.value)}
                        <button type="button" class:outside-month={!day.inMonth} class:today={day.today} class:selected-day={day.selected} aria-label={new Intl.DateTimeFormat('en', { dateStyle: 'full' }).format(new Date(`${day.value}T12:00`))} aria-pressed={day.selected} onclick={() => setPickerDate(day.value)}>{day.day}</button>
                      {/each}
                    </div>
                    <div class="calendar-quick-actions"><button type="button" onclick={() => setQuickDate(0)}>Today</button><button type="button" onclick={() => setQuickDate(1)}>Tomorrow</button><button type="button" onclick={clearPickerDate}>Clear</button></div>
                  </div>
                  <div class="time-section">
                    <span class="picker-section-label">TIME</span>
                    <label><span>Hour</span><select aria-label="Hour" value={timeHour} onchange={(event) => updatePickerTime('hour', event.currentTarget.value)}>{#each hours as hour}<option value={hour}>{hour}</option>{/each}</select></label>
                    <label><span>Minute</span><select aria-label="Minute" value={timeMinute} onchange={(event) => updatePickerTime('minute', event.currentTarget.value)}>{#each minutes as minute}<option value={minute}>{minute}</option>{/each}</select></label>
                    <label><span>Period</span><select aria-label="AM or PM" value={timePeriod} onchange={(event) => updatePickerTime('period', event.currentTarget.value)}><option value="AM">AM</option><option value="PM">PM</option></select></label>
                  </div>
                </div>
              </div>
            {/if}
          </div>

          <fieldset class="color-fieldset">
            <legend class="paper-label">PAPER COLOR</legend>
            <div class="color-options">
              {#each noteColors as color}
                <button type="button" class="color-swatch swatch-{color}" class:chosen={modalColor === color} aria-label={`Choose ${color} paper`} aria-pressed={modalColor === color} onclick={() => modalColor = color}></button>
              {/each}
            </div>
          </fieldset>

          <div class="paper-actions"><button type="button" class="cancel-note" onclick={closeEditor}>Cancel</button><button class="save-note" type="submit">{editingTaskId ? 'Save changes' : 'Add task'} <span>↗</span></button></div>
        </form>
      </dialog>
    </div>
  {/if}
  {#if reminderQueue.length}
    {@const reminder = reminderQueue[0]}
    <div class="due-reminder-overlay">
      <dialog open class="due-reminder-card" aria-modal="true" aria-labelledby="due-reminder-title" aria-describedby="due-reminder-details">
        <div class="reminder-card-top">
          <span class="reminder-brand"><span class="reminder-brand-mark">d.</span> DAYLIST REMINDER</span>
          <button class="reminder-close" type="button" aria-label="Dismiss reminder" onclick={dismissReminder}>×</button>
        </div>
        <div class="reminder-clock-mark" aria-hidden="true"><span>◷</span></div>
        <span class="due-now-label"><span></span> DUE NOW</span>
        <h2 id="due-reminder-title">Time for this task</h2>
        <p class="reminder-intro">You planned a moment for:</p>
        <div class="reminder-task-panel">
          <strong>{reminder.title}</strong>
          {#if reminder.notes}<p id="due-reminder-details">{reminder.notes}</p>{:else}<p id="due-reminder-details">Take a breath and make a start when you're ready.</p>{/if}
          {#if reminder.dueAt}<span class="reminder-due-time">SCHEDULED FOR · {formatDue(reminder.dueAt)}</span>{/if}
        </div>
        <div class="reminder-actions">
          <button class="reminder-complete" type="button" onclick={completeReminder}><span>✓</span> Mark as complete</button>
          <button class="reminder-snooze" type="button" onclick={snoozeReminder}>Remind me in 5 minutes</button>
        </div>
        <button class="reminder-dismiss" type="button" onclick={dismissReminder}>Dismiss reminder</button>
        {#if reminderQueue.length > 1}<span class="reminder-queue-count">{reminderQueue.length - 1} more due {reminderQueue.length === 2 ? 'task' : 'tasks'}</span>{/if}
      </dialog>
    </div>
  {/if}
</div>
