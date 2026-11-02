import { generateGPX, sanitizeFilename } from './gpx.js';

export function exportDataDescription(route) {
    const known = route.elevations?.filter(Number.isFinite).length || 0;
    const recorded = route.times?.filter(Boolean).length || 0;
    return `${route.coordinates.length.toLocaleString()} points · ${route.segmentStarts?.length || 1} segment(s). Elevation: ${known}/${route.coordinates.length} points${route.elevationController || route.elevationPending ? ' (still loading)' : ''}. Recorded times: ${recorded}/${route.coordinates.length} points. Missing elevations and times are omitted.${route.elevationSource?.sampled ? ' Elevation between samples is interpolated.' : ''}${route.elevationSource?.mixed ? ' Recorded and SRTM elevations are combined.' : ''}`;
}

/** Dialog state and focus live here; route data stays with the coordinator. */
export function createAppDialogs({ getRoute, onRename, downloadFile, showStatus }) {
    const listeners = new AbortController();
    const listen = (element, type, handler, capture = false) => element?.addEventListener(type, handler, { capture, signal: listeners.signal });
    let activeModal = null;
    let activeModalReturnFocus = null;
    let activeModalReturnRoute = null;
    let renameRouteId = null;
    const API_KEY_STORAGE_KEY = 'route2gpx_apiKey';
    const API_KEY_MEMORY_KEY = 'route2gpx_apiKey_session';

    function dismissModal() {
        if (activeModal?.id === 'apiKeyModal') closeApiKeyModal();
        else if (activeModal?.id === 'filenameModal') closeFilenameModal();
        else if (activeModal?.id === 'renameModal') closeRenameModal();
    }

    function getFocusableElements(container) {
        return Array.from(container.querySelectorAll(
            'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )).filter(element => !element.closest('[hidden]'));
    }

    function setAppInert(isInert) {
        const app = document.getElementById('app');
        if (!app) return;
        document.querySelectorAll('#app, .mobile-view-toggle, .skip-link').forEach(element => { element.inert = isInert; });
        if (isInert) {
            app.setAttribute('aria-hidden', 'true');
        } else {
            app.removeAttribute('aria-hidden');
        }
    }

    function openModal(modal, initialFocusElement) {
        if (activeModal && activeModal !== modal) dismissModal();
        activeModal = modal;
        activeModalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const routeElement = activeModalReturnFocus?.closest('[data-route-id]');
        activeModalReturnRoute = routeElement ? { id: routeElement.dataset.routeId, action: activeModalReturnFocus.dataset.action } : null;
        setAppInert(true);
        modal.classList.add('visible');
        (initialFocusElement || getFocusableElements(modal)[0] || modal).focus();
    }

    function closeModal(modal) {
        modal.classList.remove('visible');
        if (activeModal === modal) {
            activeModal = null;
            setAppInert(false);
            if (activeModalReturnFocus?.isConnected) {
                activeModalReturnFocus.focus();
            } else {
                const row = [...document.querySelectorAll('#routesList .route-item')]
                    .find(element => element.dataset.routeId === activeModalReturnRoute?.id);
                const action = row && [...row.querySelectorAll('[data-action]')]
                    .find(element => element.dataset.action === activeModalReturnRoute.action);
                (action || row || document.getElementById('getRouteBtn'))?.focus();
            }
            activeModalReturnFocus = null;
            activeModalReturnRoute = null;
        }
    }

    function handleModalKeydown(event) {
        if (!activeModal) return;

        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            dismissModal();
            return;
        }

        if (event.key !== 'Tab') return;

        const focusableElements = getFocusableElements(activeModal);
        if (focusableElements.length === 0) {
            event.preventDefault();
            activeModal.focus();
            return;
        }

        const first = focusableElements[0];
        const last = focusableElements[focusableElements.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }

    listen(document, 'keydown', handleModalKeydown, true);

    // ============ API Key Modal ============
    function getApiKey() {
        return getStorageItem('sessionStorage', API_KEY_MEMORY_KEY) || getStorageItem('localStorage', API_KEY_STORAGE_KEY);
    }

    function isApiKeyRemembered() {
        return Boolean(getStorageItem('localStorage', API_KEY_STORAGE_KEY));
    }

    function getStorageItem(storage, key) {
        try {
            return globalThis[storage].getItem(key) || '';
        } catch {
            return '';
        }
    }

    function removeStorageItem(storage, key) {
        try {
            globalThis[storage].removeItem(key);
            return true;
        } catch {
            return false;
        }
    }

    function showApiKeyError(message) {
        const error = document.getElementById('apiKeyError');
        if (error) { error.textContent = message; error.hidden = false; }
        showStatus(message, true);
        document.getElementById('apiKeyInput').focus();
    }

    function updateApiKeyStatus() {
        const apiKey = getApiKey();
        const btn = document.getElementById('apiKeyMapBtn');

        if (apiKey) {
            btn.classList.remove('missing');
            btn.classList.add('valid');
            btn.title = isApiKeyRemembered() ? 'API key saved on this browser — click to edit' : 'API key saved for this tab — click to edit';
            btn.setAttribute('aria-label', btn.title);
        } else {
            btn.classList.remove('valid');
            btn.classList.add('missing');
            btn.title = 'No API key — click to add';
            btn.setAttribute('aria-label', 'No API key, click to add');
        }
    }


    function openApiKeyModal() {
        const error = document.getElementById('apiKeyError');
        if (error) error.hidden = true;
        const modal = document.getElementById('apiKeyModal');
        const input = document.getElementById('apiKeyInput');
        const rememberInput = document.getElementById('rememberApiKey');
        input.value = getApiKey();
        if (rememberInput) rememberInput.checked = isApiKeyRemembered();
        updateApiKeyStorageHint();
        const remove = document.getElementById('removeApiKeyBtn');
        if (remove) remove.disabled = !getApiKey();
        openModal(modal, input);
    }

    function closeApiKeyModal() {
        const modal = document.getElementById('apiKeyModal');
        closeModal(modal);
    }

    function updateApiKeyStorageHint() {
        const rememberInput = document.getElementById('rememberApiKey');
        const hint = document.getElementById('apiKeyStorageHint');
        if (!rememberInput || !hint) return;
        hint.textContent = rememberInput.checked
            ? 'Stored in this browser until you clear it. Restrict the key to this website and the Routes API.'
            : 'Stored only in this tab and cleared when the tab closes.';
    }

    function saveApiKey() {
        const input = document.getElementById('apiKeyInput');
        const rememberInput = document.getElementById('rememberApiKey');
        const key = input.value.trim();

        if (!key) { showApiKeyError('Please enter a valid API key'); return; }
        let persistent = rememberInput?.checked === true;
        let fallback = false;
        try {
            if (persistent) localStorage.setItem(API_KEY_STORAGE_KEY, key);
            else sessionStorage.setItem(API_KEY_MEMORY_KEY, key);
        } catch (error) {
            if (!persistent) {
                console.error('Failed to save API key:', error.message);
                showApiKeyError('API key could not be saved in this browser.');
                return;
            }
            console.warn('Persistent API key storage unavailable; falling back to session storage:', error.message);
            try { sessionStorage.setItem(API_KEY_MEMORY_KEY, key); }
            catch (fallbackError) {
                console.error('Failed to save API key:', fallbackError.message);
                showApiKeyError('API key could not be saved in this browser.');
                return;
            }
            persistent = false;
            fallback = true;
            rememberInput.checked = false;
            updateApiKeyStorageHint();
        }
        const removed = persistent ? removeStorageItem('sessionStorage', API_KEY_MEMORY_KEY) : removeStorageItem('localStorage', API_KEY_STORAGE_KEY);
        updateApiKeyStatus();
        if (!removed) {
            showApiKeyError('The previous API key could not be removed. Clear this website’s browser data and retry.');
            return;
        }
        showStatus(persistent ? 'API key saved on this browser' : fallback ? 'API key saved for this tab because browser storage is unavailable' : 'API key saved for this tab');
        closeApiKeyModal();
    }


    // Close modal on Escape or click outside
    listen(document.getElementById('apiKeyModal'), 'click', function (e) {
        if (e.target === this) {
            closeApiKeyModal();
        }
    });

    listen(document.getElementById('apiKeyInput'), 'keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            saveApiKey();
        } else if (e.key === 'Escape') {
            closeApiKeyModal();
        }
    });

    function openRenameModal(id) {
        const route = getRoute(id);
        if (!route) return;
        renameRouteId = id;
        const input = document.getElementById('renameInput');
        input.value = route.name;
        openModal(document.getElementById('renameModal'), input);
        input.select();
    }

    function closeRenameModal() {
        closeModal(document.getElementById('renameModal'));
        renameRouteId = null;
    }

    function confirmRename() {
        const route = getRoute(renameRouteId);
        const name = document.getElementById('renameInput').value.trim();
        if (!name) { document.getElementById('renameInput').focus(); return; }
        if (route) onRename(route.id, name.slice(0, 200));
        closeRenameModal();
    }

    let pendingDownload = null; // { routeId, gpxContent, defaultFilename }

    function openFilenameModal(routeId, gpxContent, defaultFilename) {
        pendingDownload = { routeId, gpxContent, defaultFilename };
        const modal = document.getElementById('filenameModal');
        const input = document.getElementById('filenameInput');
        const preview = document.getElementById('filenamePreview');
        input.value = defaultFilename;
        preview.textContent = defaultFilename;
        const checkbox = document.getElementById('synthesizeTimes');
        if (checkbox) checkbox.checked = false;
        const route = getRoute(routeId);
        const hint = document.getElementById('exportDataHint');
        if (hint && route) hint.textContent = exportDataDescription(route);
        openModal(modal, input);
        input.select();
    }

    function closeFilenameModal() {
        closeModal(document.getElementById('filenameModal'));
        pendingDownload = null;
    }

    function confirmFilenameDownload() {
        if (!pendingDownload) return;
        let filename = document.getElementById('filenameInput').value.trim();
        if (!filename) filename = pendingDownload.defaultFilename;
        if (!filename.toLowerCase().endsWith('.gpx')) filename += '.gpx';
        filename = sanitizeFilename(filename.replace(/\.gpx$/i, '')) + '.gpx';
        const route = getRoute(pendingDownload.routeId);
        const content = route ? generateGPX(route, { timePolicy: document.getElementById('synthesizeTimes')?.checked ? 'synthesize' : 'preserve' }) : pendingDownload.gpxContent;
        downloadFile(content, filename, 'application/gpx+xml');
        closeFilenameModal();
    }

    // Modal event listeners
    listen(document.getElementById('filenameModal'), 'click', function (e) {
        if (e.target === this) closeFilenameModal();
    });
    listen(document.getElementById('filenameInput'), 'input', function () {
        let val = this.value.trim();
        if (!val) val = pendingDownload?.defaultFilename || 'route.gpx';
        if (!val.toLowerCase().endsWith('.gpx')) val += '.gpx';
        document.getElementById('filenamePreview').textContent = sanitizeFilename(val.replace(/\.gpx$/i, '')) + '.gpx';
    });
    listen(document.getElementById('filenameInput'), 'keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); confirmFilenameDownload(); }
        else if (e.key === 'Escape') closeFilenameModal();
    });

    listen(document.getElementById('apiKeyMapBtn'), 'click', openApiKeyModal);
    listen(document.getElementById('closeModalBtn'), 'click', closeApiKeyModal);
    listen(document.getElementById('saveApiKeyBtn'), 'click', saveApiKey);
    listen(document.getElementById('removeApiKeyBtn'), 'click', () => {
        const localRemoved = removeStorageItem('localStorage', API_KEY_STORAGE_KEY);
        const sessionRemoved = removeStorageItem('sessionStorage', API_KEY_MEMORY_KEY);
        updateApiKeyStatus();
        if (!localRemoved || !sessionRemoved) {
            showApiKeyError('The saved API key could not be removed. Clear this website’s browser data and retry.');
            return;
        }
        closeApiKeyModal(); showStatus('Saved API key removed from this browser.');
    });
    listen(document.getElementById('rememberApiKey'), 'change', updateApiKeyStorageHint);
    listen(document.getElementById('cancelFilenameBtn'), 'click', closeFilenameModal);
    listen(document.getElementById('confirmFilenameBtn'), 'click', confirmFilenameDownload);
    listen(document.getElementById('cancelRenameBtn'), 'click', closeRenameModal);
    listen(document.getElementById('confirmRenameBtn'), 'click', confirmRename);
    listen(document.getElementById('renameInput'), 'keydown', event => { if (event.key === 'Enter') { event.preventDefault(); confirmRename(); } });
    listen(document.getElementById('renameModal'), 'click', event => { if (event.target === event.currentTarget) closeRenameModal(); });
    return {
        getApiKey, updateApiKeyStatus, openApiKeyModal, closeApiKeyModal, saveApiKey,
        openRenameModal, openFilenameModal,
        destroy() { dismissModal(); listeners.abort(); },
        isOpen: id => Boolean(activeModal && (!id || activeModal.id === id)),
    };
}
