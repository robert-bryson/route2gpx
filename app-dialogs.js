import { EXPORT_FORMATS, exportFilename, generateRouteExport } from './route-export.js';

export function exportDataDescription(route) {
    const known = route.elevations?.filter(Number.isFinite).length || 0;
    const recorded = route.times?.filter(Boolean).length || 0;
    return `${route.coordinates.length.toLocaleString()} points · ${route.segmentStarts?.length || 1} segment(s). Elevation: ${known}/${route.coordinates.length} points${route.elevationController || route.elevationPending ? ' (still loading)' : ''}. Recorded times: ${recorded}/${route.coordinates.length} points. Missing values stay empty unless you select time generation.${route.elevationSource?.sampled ? ' Elevation between samples is interpolated.' : ''}${route.elevationSource?.mixed ? ' Recorded and SRTM elevations are combined.' : ''}`;
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

    const choices = document.getElementById('exportFormatChoices');
    if (choices) {
        for (const [format, metadata] of Object.entries(EXPORT_FORMATS)) {
            const label = document.createElement('label');
            label.className = 'export-format';
            const input = document.createElement('input');
            input.type = 'radio'; input.name = 'exportFormat'; input.value = format;
            input.checked = format === 'gpx';
            const name = document.createElement('span');
            name.className = 'export-format-name'; name.textContent = metadata.label;
            const description = document.createElement('span');
            description.className = 'export-format-description'; description.textContent = metadata.description;
            label.append(input, name, description); choices.append(label);
        }
    }

    function dismissModal() {
        if (activeModal?.id === 'apiKeyModal') closeApiKeyModal();
        else if (activeModal?.id === 'filenameModal') closeFilenameModal();
        else if (activeModal?.id === 'renameModal') closeRenameModal();
    }

    function getFocusableElements(container) {
        return Array.from(container.querySelectorAll(
            'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'
        )).filter(element => !element.closest('[hidden]') &&
            (!element.closest('details:not([open])') || element.tagName === 'SUMMARY') &&
            (element.type !== 'radio' || element.checked));
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

    let pendingDownload = null; // { routeId, gpxContent, defaultFilename, format }

    function openFilenameModal(routeId, gpxContent, defaultFilename = 'route.gpx') {
        const route = getRoute(routeId);
        pendingDownload = { routeId, gpxContent, defaultFilename, format: 'gpx',
            hasCompleteTimes: Boolean(route && route.times?.filter(Boolean).length === route.coordinates.length) };
        const modal = document.getElementById('filenameModal');
        const input = document.getElementById('filenameInput');
        input.value = defaultFilename;
        const formatInput = document.querySelector('input[name="exportFormat"][value="gpx"]');
        if (formatInput) formatInput.checked = true;
        const details = document.getElementById('exportDetails');
        if (details) details.open = false;
        const checkbox = document.getElementById('synthesizeTimes');
        if (checkbox) checkbox.checked = false;
        const hint = document.getElementById('exportDataHint');
        if (hint) hint.textContent = route ? exportDataDescription(route) : '';
        updateExportChoice();
        openModal(modal, formatInput || input);
    }

    function closeFilenameModal() {
        closeModal(document.getElementById('filenameModal'));
        pendingDownload = null;
    }

    function confirmFilenameDownload() {
        if (!pendingDownload) return;
        const { format } = pendingDownload;
        const filename = exportFilename(document.getElementById('filenameInput').value.trim() || pendingDownload.defaultFilename, format);
        const route = getRoute(pendingDownload.routeId);
        if (!route && (format !== 'gpx' || !pendingDownload.gpxContent)) {
            showStatus('This route is no longer available to download.', true);
            closeFilenameModal();
            return;
        }
        try {
            const content = route ? generateRouteExport(route, format, { timePolicy: document.getElementById('synthesizeTimes')?.checked ? 'synthesize' : 'preserve' }) : pendingDownload.gpxContent;
            downloadFile(content, filename, EXPORT_FORMATS[format].mimeType);
        } catch (error) {
            showExportError(`Download failed: ${error.message}`);
            showStatus(`Download failed: ${error.message}`, true);
            return;
        }
        closeFilenameModal();
    }

    function updateFilenamePreview() {
        if (!pendingDownload) return;
        const { format } = pendingDownload;
        const input = document.getElementById('filenameInput');
        input.placeholder = `route.${format}`;
        document.getElementById('filenamePreview').textContent = exportFilename(input.value.trim() || pendingDownload.defaultFilename, format);
    }

    function showExportError(message) {
        const error = document.getElementById('exportError');
        if (error) { error.textContent = message; error.hidden = !message; }
    }

    function updateExportChoice() {
        if (!pendingDownload) return;
        updateFilenamePreview();
        const { format } = pendingDownload;
        const metadata = EXPORT_FORMATS[format];
        const hint = document.getElementById('exportFormatHint');
        if (hint) hint.textContent = metadata.hint;
        const times = document.getElementById('exportTimestampOption');
        if (times) {
            times.hidden = !metadata.supportsGeneratedTimes;
            // TCX's required time choice must be visible without expanding optional details.
            const container = metadata.requiresCompleteTimes ? document.getElementById('exportRequiredOptions') : document.getElementById('exportDetails');
            if (times.parentElement !== container) container.append(times);
        }
        const needsTimes = metadata.requiresCompleteTimes && !pendingDownload.hasCompleteTimes && !document.getElementById('synthesizeTimes').checked;
        const button = document.getElementById('confirmFilenameBtn');
        button.textContent = `Download ${metadata.label}`;
        button.disabled = Boolean(needsTimes);
        showExportError(needsTimes ? 'TCX needs a time for every point. Select Generate new timestamps, or choose GPX.' : '');
    }

    // Modal event listeners
    listen(document.getElementById('filenameModal'), 'click', function (e) {
        if (e.target === this) closeFilenameModal();
    });
    listen(document.getElementById('filenameInput'), 'input', updateFilenamePreview);
    listen(document.getElementById('synthesizeTimes'), 'change', updateExportChoice);
    listen(document.getElementById('exportFormats'), 'change', event => {
        if (!pendingDownload || !Object.hasOwn(EXPORT_FORMATS, event.target.value)) return;
        pendingDownload.format = event.target.value;
        const input = document.getElementById('filenameInput');
        if (input.value.trim()) input.value = exportFilename(input.value, pendingDownload.format);
        updateExportChoice();
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
