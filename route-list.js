import { iconSvg, getModeIconSvg } from './icons.js';

export function escapeHtml(text) {
    return String(text ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[char]));
}

export function formatDuration(durationStr) {
    const seconds = parseInt(durationStr?.replace('s', ''), 10);
    if (!Number.isFinite(seconds)) return '—';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
}

/** Owns route row markup, focus recovery, hover, and popup presentation. */
export function createRouteList({ list, formatDistance, getRouteColorClass, onZoom, onHighlight }) {
    function createRoutePopup(route) {
        const pointCount = route.coordinates.length;
        const segmentCount = route.segmentStarts?.length || 1;
        const stopCount = route.stops ? route.stops.length : 0;

        return `
            <div class="route-popup">
                <h4>${escapeHtml(route.name)}</h4>
                <div class="route-meta">
                    <span>${iconSvg('ruler', 'icon-sm')} ${formatDistance(route.distance)}</span>
                    <span>${iconSvg('clock', 'icon-sm')} ${formatDuration(route.duration)}</span>
                </div>
                <div class="route-meta">
                    <span>${getModeIconSvg(route.travelMode)} ${escapeHtml(route.travelMode.toLowerCase())}</span>
                    ${stopCount > 0 ? `<span>${iconSvg('map-pin', 'icon-sm')} ${stopCount} stop${stopCount > 1 ? 's' : ''}</span>` : ''}
                </div>
                <div class="route-meta route-meta-border">
                    <span>${iconSvg('route', 'icon-sm')} ${segmentCount} segment${segmentCount === 1 ? '' : 's'}</span>
                    <span>${iconSvg('route', 'icon-sm')} ${pointCount.toLocaleString()} points</span>
                </div>
                <div class="popup-actions">
                    <button class="popup-btn download" data-action="download-route" data-route-id="${route.id}" title="Download GPX">
                        ${iconSvg('download', 'icon-sm')} Download
                    </button>
                    <button class="popup-btn delete" data-action="remove-route" data-route-id="${route.id}" title="Remove route">
                        ${iconSvg('trash-2', 'icon-sm')} Remove
                    </button>
                </div>
            </div>
        `;
    }

    function scrollRouteItemIntoViewIfNeeded(routeItem) {
        if (!list || !routeItem || !list.contains(routeItem) || list.clientHeight === 0) return;

        const listRect = list.getBoundingClientRect();
        const itemRect = routeItem.getBoundingClientRect();
        const scrollPadding = 6;

        if (itemRect.top >= listRect.top && itemRect.bottom <= listRect.bottom) return;

        if (itemRect.top < listRect.top) {
            list.scrollTop += itemRect.top - listRect.top - scrollPadding;
        } else if (itemRect.bottom > listRect.bottom) {
            list.scrollTop += itemRect.bottom - listRect.bottom + scrollPadding;
        }
    }

    function highlightRouteListItem(id, active) {
        const item = list.querySelector(`.route-item[data-route-id="${id}"]`);
        if (!item) return;
        item.classList.toggle('highlighted', active);
        if (active) scrollRouteItemIntoViewIfNeeded(item);
    }

    function render(routes) {
        const focused = document.activeElement;
        const focusedRow = focused?.closest?.('.route-item');
        const focusState = focusedRow && list.contains(focused) ? { id: focusedRow.dataset.routeId, action: focused.dataset.action, index: [...list.children].indexOf(focusedRow) } : null;

        if (routes.length === 0) {
            list.innerHTML = `
                <div class="routes-empty-state">
                    <div class="routes-empty-state-icon">${iconSvg('map', 'empty-state-icon')}</div>
                    <div class="routes-empty-state-title">No routes yet</div>
                    <div class="routes-empty-state-copy">Enter an origin and destination, or open a GPS file.</div>
                    <button type="button" class="btn-outline" data-action="browse-import">Import GPS file</button>
                </div>
            `;
            if (focusState) list.querySelector('button')?.focus();
            return;
        }

        list.innerHTML = routes.map((route, idx) => `
            <div class="route-item ${getRouteColorClass(route.color, idx)}" role="listitem"
                 data-route-id="${route.id}"
                 tabindex="0"
                 aria-label="Route ${idx + 1}: ${escapeHtml(route.name)}. Press Enter to zoom and view details.">
                <div class="route-item-header">
                    <div>
                        <div class="route-title-row">
                        <span class="route-number" aria-hidden="true">${idx + 1}</span>
                        <div class="route-item-title">${escapeHtml(route.name)}</div>
                        </div>
                        <div class="route-item-meta">
                            <span class="route-meta-item">${getModeIconSvg(route.travelMode)} ${escapeHtml(route.travelMode.toLowerCase())}</span> •
                            ${formatDistance(route.distance)} • ${formatDuration(route.duration)}
                            ${route.stops.length > 0 ? ` • ${route.stops.length} stop(s)` : ''}
                            ${getElevationStatusText(route) ? ` • <span class="route-elevation-status">${getElevationStatusText(route)}</span>` : ''}
                        </div>
                    </div>
                </div>
                <div class="route-item-actions">
                    ${route.request ? `<button type="button" class="btn-outline btn-small" data-action="edit-route" data-route-id="${route.id}">Edit / reuse</button>` : ''}
                    <button type="button" class="btn-outline btn-small" data-action="rename-route" data-route-id="${route.id}" aria-label="Rename ${escapeHtml(route.name)}">Rename</button>
                    ${route.elevationStatus !== 'ready' ? `<button type="button" class="btn-outline btn-small" data-action="${route.elevationController ? 'cancel-elevation' : 'retry-elevation'}" data-route-id="${route.id}">${route.elevationController ? 'Pause elevation' : route.elevations?.some(value => value !== null) ? 'Retry elevation' : 'Add elevation'}</button>` : ''}
                    <button class="btn-outline btn-small" data-action="toggle-visibility" data-route-id="${route.id}"
                            aria-label="${route.visible ? 'Hide' : 'Show'} route"
                            title="${route.visible ? 'Hide this route from the map' : 'Show this route on the map'}">
                        <span class="icon-label">${iconSvg(route.visible ? 'eye-off' : 'eye', 'icon-sm')} ${route.visible ? 'Hide' : 'Show'}</span>
                    </button>
                    <button class="btn-outline btn-small" data-action="download-route" data-route-id="${route.id}"
                            aria-label="Download GPX for ${escapeHtml(route.name)}"
                            title="Download as GPX file for GPS devices">
                        <span class="icon-label">${iconSvg('file-down', 'icon-sm')} GPX</span>
                    </button>
                    <button class="btn-secondary btn-small" data-action="remove-route" data-route-id="${route.id}"
                            aria-label="Delete route ${escapeHtml(route.name)}"
                            title="Remove this route permanently">
                        ${iconSvg('trash-2', 'icon-sm')}
                    </button>
                </div>
            </div>
        `).join('');
        if (focusState) {
            const row = [...list.children].find(item => item.dataset.routeId === focusState.id) || list.children[Math.min(focusState.index, list.children.length - 1)];
            (row?.querySelector(`[data-action="${focusState.action}"]`) || row)?.focus({ preventScroll: true });
        }
    }

    function getElevationStatusText(route) {
        if (route.elevationStatus === 'loading') return route.elevationProgress ? `elevation ${route.elevationProgress.completed}/${route.elevationProgress.total}` : 'adding elevation';
        if (route.elevationStatus === 'partial') return 'partial elevation';
        if (route.elevationStatus === 'cancelled') return 'elevation paused';
        if (route.elevationStatus === 'ready') return route.elevationSource?.sampled ? 'sampled elevation' : 'elevation ready';
        if (route.elevationStatus === 'unavailable') return 'no elevation';
        return '';
    }

    list.addEventListener('click', function (e) {
        // Action buttons are handled by the coordinator's document listener.
        if (e.target.closest('[data-action]')) return;
        // Stop propagation container
        if (e.target.closest('.route-item-actions')) return;

        const item = e.target.closest('.route-item');
        if (item) {
            const id = Number(item.dataset.routeId);
            onZoom(id);
        }
    });

    list.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.target.closest('button, input, a')) {
            e.preventDefault();
            const item = e.target.closest('.route-item');
            if (item) {
                onZoom(Number(item.dataset.routeId));
            }
        }
    });

    list.addEventListener('mouseenter', function (e) {
        const item = e.target.closest('.route-item');
        if (item === e.target) onHighlight(Number(item.dataset.routeId), true);
    }, true);

    list.addEventListener('mouseleave', function (e) {
        const item = e.target.closest('.route-item');
        if (item === e.target) onHighlight(Number(item.dataset.routeId), false);
    }, true);

    return { render, highlight: highlightRouteListItem, popup: createRoutePopup };
}
