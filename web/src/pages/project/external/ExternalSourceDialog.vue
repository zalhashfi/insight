<script setup lang="ts">
import { computed, ref } from 'vue';
import { useProjectStore } from '../../../stores/project';
import { toast } from '../../../lib/toast';
import type { ExternalSource, ExternalSourceField, ExternalSourcePreview } from '../../../types';

const props = defineProps<{ source: ExternalSource | null }>();
const emit = defineEmits<{ saved: []; cancel: [] }>();

const project = useProjectStore();
const isEdit = computed(() => props.source !== null);

const name = ref(props.source?.name ?? '');
const url = ref(props.source?.url ?? '');
const deviceKey = ref(props.source?.device_key ?? '');
const intervalMinutes = ref<2 | 5 | 15 | 30 | 60>(props.source?.interval_minutes ?? 5);
const envelopePath = ref(props.source?.envelope_path ?? '');
const cursorField = ref(props.source?.cursor_field ?? 'id');
const sentinelText = ref(
  JSON.stringify(props.source?.sentinel_map ?? { temperature: [-1, '-1.00'] }, null, 2)
);
const headersText = ref('{}');
const enabled = ref(props.source?.enabled ?? true);

const preview = ref<ExternalSourcePreview | null>(null);
const previewError = ref<string | null>(null);
const testing = ref(false);
const saving = ref(false);
const selected = ref<Set<string>>(
  new Set(props.source?.fields ?? [])
);

const sentinelError = computed(() => {
  if (!sentinelText.value.trim()) return null;
  try {
    const v = JSON.parse(sentinelText.value);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'Must be a JSON object';
    return null;
  } catch {
    return 'Invalid JSON';
  }
});

const headersError = computed(() => {
  if (!headersText.value.trim()) return null;
  try {
    const v = JSON.parse(headersText.value);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'Must be a JSON object';
    return null;
  } catch {
    return 'Invalid JSON';
  }
});

function fieldInvalid(f: ExternalSourceField): boolean {
  return f.invalid;
}

function toggleField(key: string) {
  const next = new Set(selected.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  selected.value = next;
}

async function runTest() {
  testing.value = true;
  previewError.value = null;
  try {
    let headers: Record<string, string> = {};
    if (headersText.value.trim()) headers = JSON.parse(headersText.value);
    let sentinels: Record<string, Array<number | string>> | undefined;
    if (sentinelText.value.trim()) sentinels = JSON.parse(sentinelText.value);
    const out = await project.previewExternalSource({
      url: url.value.trim(),
      envelope_path: envelopePath.value.trim(),
      headers,
      sentinel_map: sentinels,
    });
    preview.value = out;
    if (!cursorField.value || isEdit.value === false) {
      cursorField.value = out.suggested_cursor;
    }
    if (selected.value.size === 0) {
      selected.value = new Set(out.fields.filter((f) => f.kinds.includes('number')).map((f) => f.key));
    }
  } catch (e) {
    previewError.value = (e as Error).message;
    preview.value = null;
  } finally {
    testing.value = false;
  }
}

async function save() {
  if (sentinelError.value || headersError.value) return;
  if (selected.value.size === 0) {
    toast.error('Tick at least one field');
    return;
  }
  saving.value = true;
  try {
    const sentinels = sentinelText.value.trim() ? JSON.parse(sentinelText.value) : {};
    const headers = headersText.value.trim() && headersText.value.trim() !== '{}'
      ? JSON.parse(headersText.value)
      : undefined;
    const payload = {
      name: name.value.trim(),
      url: url.value.trim(),
      device_key: deviceKey.value.trim(),
      interval_minutes: intervalMinutes.value,
      envelope_path: envelopePath.value.trim(),
      fields: [...selected.value],
      cursor_field: cursorField.value.trim() || 'id',
      sentinel_map: sentinels,
      ...(headers ? { headers } : {}),
      enabled: enabled.value,
    };
    if (isEdit.value && props.source) {
      await project.updateExternalSource(props.source.id, payload);
    } else {
      await project.createExternalSource(payload);
    }
    toast.success('External source saved');
    emit('saved');
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="mb-6 rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
    <h3 class="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
      {{ isEdit ? 'Edit external source' : 'New external source' }}
    </h3>

    <div class="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
      <label class="block">
        <span class="text-xs font-medium text-neutral-600 dark:text-neutral-300">Name</span>
        <input v-model="name" type="text" placeholder="TULT" class="mt-1 w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-950" />
      </label>
      <label class="block">
        <span class="text-xs font-medium text-neutral-600 dark:text-neutral-300">Device key</span>
        <input v-model="deviceKey" type="text" placeholder="TULT" class="mt-1 w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-950" />
      </label>
      <label class="block sm:col-span-2">
        <span class="text-xs font-medium text-neutral-600 dark:text-neutral-300">URL</span>
        <input v-model="url" type="text" spellcheck="false" placeholder="https://biru-langit.com/api/TULT/2m" class="mt-1 w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-950" />
      </label>
      <label class="block">
        <span class="text-xs font-medium text-neutral-600 dark:text-neutral-300">Interval (aligned to wall clock +30s)</span>
        <select v-model="intervalMinutes" class="mt-1 w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-xs dark:border-neutral-700 dark:bg-neutral-950">
          <option :value="2">Every 2 minutes</option>
          <option :value="5">Every 5 minutes</option>
          <option :value="15">Every 15 minutes</option>
          <option :value="30">Every 30 minutes</option>
          <option :value="60">Every 60 minutes</option>
        </select>
      </label>
      <label class="block">
        <span class="text-xs font-medium text-neutral-600 dark:text-neutral-300">Envelope path (optional)</span>
        <input v-model="envelopePath" type="text" spellcheck="false" placeholder="data.items (empty = root array)" class="mt-1 w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-950" />
      </label>
      <label class="block">
        <span class="text-xs font-medium text-neutral-600 dark:text-neutral-300">Cursor field</span>
        <input v-model="cursorField" type="text" spellcheck="false" placeholder="id" class="mt-1 w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-950" />
      </label>
      <label class="flex items-center gap-2">
        <input v-model="enabled" type="checkbox" class="h-4 w-4" />
        <span class="text-xs font-medium text-neutral-600 dark:text-neutral-300">Enabled</span>
      </label>
      <label class="block sm:col-span-2">
        <span class="text-xs font-medium text-neutral-600 dark:text-neutral-300">Sentinels (JSON, INVALID badge only, values still stored)</span>
        <textarea v-model="sentinelText" rows="3" spellcheck="false" placeholder='{"temperature": [-1, "-1.00"]}' class="mt-1 w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-950"></textarea>
        <span v-if="sentinelError" class="mt-1 block text-xs text-red-600 dark:text-red-400">{{ sentinelError }}</span>
      </label>
      <label v-if="!isEdit" class="block sm:col-span-2">
        <span class="text-xs font-medium text-neutral-600 dark:text-neutral-300">Headers (JSON, optional, e.g. API key)</span>
        <textarea v-model="headersText" rows="2" spellcheck="false" placeholder='{"authorization": "Bearer …"}' class="mt-1 w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-950"></textarea>
        <span v-if="headersError" class="mt-1 block text-xs text-red-600 dark:text-red-400">{{ headersError }}</span>
      </label>
    </div>

    <div class="mt-3 flex flex-wrap items-center gap-2">
      <button
        type="button"
        class="rounded-md border border-neutral-300 px-2.5 py-1.5 text-xs font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
        :disabled="testing || !url.trim()"
        @click="runTest"
      >{{ testing ? 'Testing…' : 'Test & Preview' }}</button>
      <span v-if="previewError" class="text-xs text-red-600 dark:text-red-400">{{ previewError }}</span>
      <span v-else-if="preview" class="text-xs text-neutral-500 dark:text-neutral-400">
        {{ preview.total }} record(s), showing last {{ preview.records.length }}
      </span>
    </div>

    <div v-if="preview" class="mt-3 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
      <table class="w-full text-left font-mono text-[11px]">
        <thead>
          <tr class="border-b border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950">
            <th class="px-2 py-1.5 font-semibold">Use</th>
            <th class="px-2 py-1.5 font-semibold">Field</th>
            <th class="px-2 py-1.5 font-semibold">Types</th>
            <th class="px-2 py-1.5 font-semibold">Sample</th>
            <th class="px-2 py-1.5 font-semibold">Flag</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="f in preview.fields" :key="f.key" class="border-b border-neutral-100 last:border-0 dark:border-neutral-800/60">
            <td class="px-2 py-1.5"><input type="checkbox" :checked="selected.has(f.key)" class="h-3.5 w-3.5" @change="toggleField(f.key)" /></td>
            <td class="px-2 py-1.5">{{ f.key }}</td>
            <td class="px-2 py-1.5 text-neutral-500">{{ f.kinds.join(' | ') }}</td>
            <td class="max-w-48 truncate px-2 py-1.5">{{ String(f.sample) }}</td>
            <td class="px-2 py-1.5">
              <span v-if="fieldInvalid(f)" class="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">INVALID</span>
              <span v-else class="text-neutral-400">ok</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="preview && preview.records.length" class="mt-3">
      <h4 class="mb-1.5 text-xs font-semibold text-neutral-700 dark:text-neutral-300">
        Last {{ preview.records.length }} records (newest last, sorted by {{ preview.suggested_cursor }})
      </h4>
      <div class="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
        <table class="w-full text-left font-mono text-[11px]">
          <thead>
            <tr class="border-b border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950">
              <th v-for="f in preview.fields.slice(0, 6)" :key="f.key" class="px-2 py-1.5 font-semibold">{{ f.key }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(r, i) in preview.records" :key="i" class="border-b border-neutral-100 last:border-0 dark:border-neutral-800/60">
              <td v-for="f in preview.fields.slice(0, 6)" :key="f.key" class="max-w-32 truncate px-2 py-1.5">{{ String(r[f.key] ?? '') }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400">
        Compare the bottom row (newest, {{ preview.total }} total) with your browser tab to validate freshness.
      </p>
    </div>

    <div class="mt-3 flex items-center gap-2">
      <button
        type="button"
        class="rounded-md bg-accent-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent-700 disabled:opacity-50"
        :disabled="saving || !!sentinelError || !!headersError"
        @click="save"
      >{{ saving ? 'Saving…' : 'Save' }}</button>
      <button
        type="button"
        class="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
        @click="emit('cancel')"
      >Cancel</button>
    </div>
  </div>

</template>
