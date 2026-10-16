// @ts-check
(() => {
  const vscode = acquireVsCodeApi();
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const draftBody = /** @type {HTMLTextAreaElement} */ ($('draft-body'));
  const general = /** @type {HTMLTextAreaElement} */ ($('general'));
  const publishButton = /** @type {HTMLButtonElement} */ ($('publish'));

  /** @type {{draft: any, comments: any[], general: string, status: string}} */
  let state = { draft: null, comments: [], general: '', status: '' };
  /** Which draft the comment box shows ('new' or a comment id), so re-renders keep what you typed. */
  let draftKey = null;

  window.addEventListener('message', ({ data }) => {
    if (data.type !== 'state') return;
    state = data;
    render();
  });

  function render() {
    const { draft, comments } = state;
    $('hint').hidden = !!draft || comments.length > 0;
    $('draft').hidden = !draft;
    if (draft) {
      $('draft-location').textContent = draft.location + (draft.editing ? ' · editing' : '');
      $('draft-code').textContent = draft.code;
      $('save').textContent = draft.editing ? 'Save' : 'Add';
      if (draft.key !== draftKey) draftBody.value = draft.body;
      draftKey = draft.key;
    } else {
      draftKey = null;
      draftBody.value = '';
    }
    // The extension owns the overall note; don't overwrite it while it is being typed.
    if (document.activeElement !== general && general.value !== state.general) general.value = state.general;

    $('list').replaceChildren(...comments.map(commentElement));
    $('list-section').hidden = comments.length === 0;
    $('list-title').textContent = `Comments · ${comments.length}`;
    $('status').textContent = state.status;
    updatePublishButton();
  }

  function commentElement(/** @type {any} */ c) {
    const root = element('div', 'comment');
    const head = element('div', 'head');
    const loc = element('span', 'location', c.location);
    loc.title = 'Show in diff';
    loc.onclick = () => vscode.postMessage({ type: 'reveal', id: c.id });
    head.append(
      loc,
      iconButton('✎', 'Edit', () => vscode.postMessage({ type: 'edit', id: c.id })),
      iconButton('✕', 'Delete', () => vscode.postMessage({ type: 'delete', id: c.id })),
    );
    root.append(head, element('pre', '', c.code), element('div', 'body', c.body));
    return root;
  }

  function element(/** @type {string} */ tag, /** @type {string} */ className, text = '') {
    const el = document.createElement(tag);
    if (className) el.className = className;
    el.textContent = text;
    return el;
  }

  function iconButton(/** @type {string} */ label, /** @type {string} */ title, /** @type {() => void} */ onclick) {
    const button = element('button', 'icon', label);
    button.title = title;
    button.onclick = onclick;
    return button;
  }

  function updatePublishButton() {
    const count = state.comments.length;
    publishButton.disabled = count === 0 && !general.value.trim();
    publishButton.textContent = count ? `Publish (${count})` : 'Publish';
  }

  function save() {
    if (!draftBody.value.trim()) return;
    vscode.postMessage({ type: 'save', body: draftBody.value });
  }

  function publish() {
    if (!publishButton.disabled) vscode.postMessage({ type: 'publish' });
  }

  const isSubmit = (/** @type {KeyboardEvent} */ e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey);

  // Both boxes are mirrored to the extension as you type, so closing the window loses nothing.
  draftBody.addEventListener('input', () => vscode.postMessage({ type: 'draftInput', body: draftBody.value }));
  draftBody.addEventListener('keydown', (e) => {
    if (isSubmit(e)) {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      vscode.postMessage({ type: 'cancel' });
    }
  });
  general.addEventListener('input', () => {
    vscode.postMessage({ type: 'generalInput', text: general.value });
    updatePublishButton();
  });
  general.addEventListener('keydown', (e) => {
    if (isSubmit(e)) {
      e.preventDefault();
      publish();
    }
  });
  $('save').onclick = save;
  $('cancel').onclick = () => vscode.postMessage({ type: 'cancel' });
  publishButton.onclick = publish;

  vscode.postMessage({ type: 'ready' });
})();
