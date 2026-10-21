// Mirrors Stash's translateJSON (ui/v2.5/src/models/list-filter/filter.ts):
// c-params are JSON with `{` ↔ `(` substitution outside strings, and a
// proper escape flag for `\` so `\\"` doesn't confuse the parser.
export function parseCParam(raw) {
    let result = '';
    let inString = false;
    let escape = false;
    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (escape) { escape = false; result += ch; continue; }
        if (inString && ch === '\\') { escape = true; result += ch; continue; }
        if (ch === '"') { inString = !inString; result += ch; continue; }
        if (!inString && ch === '(') { result += '{'; continue; }
        if (!inString && ch === ')') { result += '}'; continue; }
        result += ch;
    }
    return JSON.parse(result);
}

// Stash UI stores some enum criteria as their display string in URL/state
// but sends the GraphQL enum to the API. We mirror those mappings here.
export const RESOLUTION_TO_ENUM = {
    '144p': 'VERY_LOW', '240p': 'LOW', '360p': 'R360P', '480p': 'STANDARD',
    '540p': 'WEB_HD', '720p': 'STANDARD_HD', '1080p': 'FULL_HD', '1440p': 'QUAD_HD',
    '4k': 'FOUR_K', '5k': 'FIVE_K', '6k': 'SIX_K', '7k': 'SEVEN_K',
    '8k': 'EIGHT_K', 'Huge': 'HUGE'
};
export const ORIENTATION_TO_ENUM = {
    Landscape: 'LANDSCAPE', Portrait: 'PORTRAIT', Square: 'SQUARE'
};

export function mapResolution(v) {
    if (v == null) return undefined;
    if (RESOLUTION_TO_ENUM[v]) return RESOLUTION_TO_ENUM[v];
    // Case-insensitive fallback (matches Stash's stringToResolution behavior)
    const lower = String(v).toLowerCase();
    for (const k of Object.keys(RESOLUTION_TO_ENUM)) {
        if (k.toLowerCase() === lower) return RESOLUTION_TO_ENUM[k];
    }
    return undefined;
}

export function mapOrientation(v) {
    if (v == null) return undefined;
    if (ORIENTATION_TO_ENUM[v]) return ORIENTATION_TO_ENUM[v];
    const upper = String(v).toUpperCase();
    if (upper === 'LANDSCAPE' || upper === 'PORTRAIT' || upper === 'SQUARE') return upper;
    return undefined;
}

export function applySceneFilterCriterion(sf, type, modifier, value) {
    const isNullMod = modifier === 'IS_NULL' || modifier === 'NOT_NULL';

    // Plain multi (items/excluded) — MultiCriterionInput
    if (['performers', 'movies', 'galleries'].includes(type)) {
        sf[type] = {
            value:    (value?.items    || []).map(i => i.id),
            excludes: (value?.excluded || []).map(i => i.id),
            modifier
        };
        return;
    }
    // Hierarchical multi (depth) — HierarchicalMultiCriterionInput
    if (['tags', 'studios', 'groups', 'performer_tags'].includes(type)) {
        sf[type] = {
            value:    (value?.items    || []).map(i => i.id),
            excludes: (value?.excluded || []).map(i => i.id),
            modifier,
            depth:    value?.depth ?? 0
        };
        return;
    }
    // String criteria — StringCriterionInput (value: String!)
    if (['path', 'title', 'code', 'details', 'director', 'url', 'captions',
         'video_codec', 'audio_codec', 'oshash', 'checksum', 'phash'].includes(type)) {
        sf[type] = { value: isNullMod ? '' : (value ?? ''), modifier };
        return;
    }
    // Numeric — IntCriterionInput (value: Int!)
    if (['id', 'rating100', 'o_counter', 'play_count', 'play_duration', 'duration',
         'framerate', 'bitrate', 'interactive_speed', 'resume_time', 'file_count',
         'performer_age', 'performer_count', 'tag_count', 'stash_id_count'].includes(type)) {
        sf[type] = isNullMod
            ? { value: 0, modifier }
            : { value: value?.value ?? 0, value2: value?.value2, modifier };
        return;
    }
    // Date/Timestamp — value: String!
    if (['date', 'created_at', 'updated_at', 'last_played_at'].includes(type)) {
        sf[type] = isNullMod
            ? { value: '', modifier }
            : { value: value?.value ?? '', value2: value?.value2, modifier };
        return;
    }
    // Plain booleans — no modifier wrapper in SceneFilterType
    if (['organized', 'performer_favorite', 'interactive'].includes(type)) {
        sf[type] = value === 'true' || value === true;
        return;
    }
    // Stash treats these as plain strings (not criterion objects) in
    // SceneFilterType — the modifier is discarded.
    if (type === 'has_markers' || type === 'is_missing') {
        sf[type] = String(value ?? '');
        return;
    }
    // Resolution: friendly "1080p" → enum FULL_HD
    if (type === 'resolution') {
        const enumVal = mapResolution(value);
        if (enumVal) sf.resolution = { value: enumVal, modifier };
        return;
    }
    // Orientation: ["Landscape","Square"] → ["LANDSCAPE","SQUARE"];
    // OrientationCriterionInput only carries `value`, no modifier.
    if (type === 'orientation') {
        const arr = Array.isArray(value) ? value : (value != null ? [value] : []);
        const mapped = arr.map(mapOrientation).filter(Boolean);
        if (mapped.length) sf.orientation = { value: mapped };
        return;
    }
    // PhashDistanceCriterionInput { value: String!, modifier, distance? }
    if (type === 'phash_distance') {
        sf.phash_distance = isNullMod
            ? { value: '', modifier }
            : { value: value?.value ?? '', modifier, distance: value?.distance };
        return;
    }
    // DuplicationCriterionInput — flat object, no modifier
    if (type === 'duplicated' && value && typeof value === 'object') {
        sf.duplicated = {
            duplicated: value.duplicated,
            distance:   value.distance,
            phash:      value.phash,
            url:        value.url,
            stash_id:   value.stash_id,
            title:      value.title
        };
        return;
    }
    // StashIDCriterionInput — value uses camelCase stashID in c-param;
    // GraphQL expects stash_id. For IS_NULL/NOT_NULL with no endpoint,
    // Stash omits the value entirely.
    if (type === 'stash_id_endpoint') {
        sf.stash_id_endpoint = (isNullMod && !value?.endpoint)
            ? { modifier }
            : { endpoint: value?.endpoint || undefined,
                stash_id: value?.stashID || value?.stash_id || undefined,
                modifier };
        return;
    }
    if (type === 'stash_ids_endpoint') {
        sf.stash_ids_endpoint = (isNullMod && !value?.endpoint)
            ? { modifier }
            : { endpoint: value?.endpoint || undefined,
                stash_ids: value?.stashIDs || value?.stash_ids || undefined,
                modifier };
        return;
    }
    // FolderCriterion has type "folder" in the c-param but writes into
    // files_filter.parent_folder on SceneFilterType (see Stash's
    // criteria/folder.ts:applyToCriterionInput). Value shape is the
    // hierarchical {items, excluded, depth}.
    if (type === 'folder') {
        sf.files_filter = sf.files_filter || {};
        sf.files_filter.parent_folder = {
            value:    (value?.items    || []).map(i => i.id),
            excludes: (value?.excluded || []).map(i => i.id),
            modifier,
            depth:    value?.depth ?? 0
        };
        return;
    }
    // CustomFieldsCriterion has its own toQueryParams: value is an
    // array of CustomFieldCriterionInput {field, modifier, value} and
    // there's no top-level modifier. Pass through verbatim.
    if (type === 'custom_fields') {
        sf.custom_fields = Array.isArray(value) ? value : [];
        return;
    }
    // Unknown criterion — silently ignored. AND/OR/NOT are not produced
    // by Stash's filter UI so they should never appear here.
}

export function buildSceneFilter(f) {
    const sf = {};
    // Mirror Stash's entity-scope filter hooks (src/core/{performers,
    // tags,studios,groups}.ts). depth: -1 matches the default
    // `showAllDetails`/`showChildContent` toggle being on, which
    // includes scenes from descendants. INCLUDES_ALL for performers
    // and tags, INCLUDES for studios and groups — same as upstream.
    if (f.performerId) sf.performers = { value: [f.performerId], excludes: [], modifier: 'INCLUDES_ALL' };
    if (f.tagId)       sf.tags       = { value: [f.tagId],       excludes: [], modifier: 'INCLUDES_ALL', depth: -1 };
    if (f.studioId)    sf.studios    = { value: [f.studioId],    excludes: [], modifier: 'INCLUDES',     depth: -1 };
    if (f.groupId)     sf.groups     = { value: [f.groupId],     excludes: [], modifier: 'INCLUDES',     depth: -1 };
    for (const raw of (f.c || [])) {
        try {
            const { type, modifier, value } = parseCParam(raw);
            applySceneFilterCriterion(sf, type, modifier, value);
        } catch {}
    }
    return Object.keys(sf).length ? sf : undefined;
}
