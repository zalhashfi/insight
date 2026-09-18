<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useProjectStore } from '../../../stores/project';
import { confirm } from '../../../lib/confirm';
import { toast } from '../../../lib/toast';
import Icon from '../../../components/Icon.vue';
import ExternalSourceDialog from './ExternalSourceDialog.vue';
import type { ExternalSource } from '../../../types';

const project = useProjectStore();
const dialogOpen = ref(false);
const editing = ref<ExternalSource | null>(null);
const runningId = ref<string | null>(null);
const EMPTY_ICON = 'M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244';
const loading = ref(true);
const loadError = ref<string | null>(null);

async function reload() {
  loading.value = true;
  loadError.value = null;
  try {
    await project.loadExternalSources();
  } catch (e) {
    loadError.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

function retryLoad() {
  void reload();
}

onMounted(() => {
  void reload();
});

function openCreate() {
  editing.value = null;
  dialogOpen.value = true;
}

function openEdit(s: ExternalSource) {
  editing.value = s;
  dialogOpen.value = true;
}

function closeDialog() {
  dialogOpen.value = false;
  editing.value = null;
}

function statusTone(s: ExternalSource): string {
  if (!s.enabled) return 'text-neutral-400';
  if (s.last_run_status === 'error') return 'text-red-600 dark:text-red-400';
  if (s.last_run_status === 'ok') return 'text-emerald-600 dark:text-emerald-400';
  return 'text-neutral-400';
}

function statusLabel(s: ExternalSource): string {
  if (!s.enabled) return 'Disabled';
  if (s.last_run_status === 'error') return `Error: ${s.last_error ?? 'poll failed'}`;
  if (s.last_run_status === 'ok') {
    return s.last_cursor ? `Last cursor ${s.last_cursor}` : 'Polling';
  }
  return 'Never polled';
}

async function toggleEnabled(s: ExternalSource) {
  try {
    await project.updateExternalSource(s.id, { enabled: !s.enabled });
  } catch (e) {
    toast.error((e as Error).message);
  }
}

async function pollNow(s: ExternalSource) {
  runningId.value = s.id;
  try {
    const res = await project.runExternalSourceNow(s.id);
    if (res.status === 'ok' && res.detail === 'no_new_data') {
      toast.success('No new data, already up to date');
    } else {
      toast.success(`Polled ${res.points ?? 0} variable(s)`);
    }
    await project.loadDevices();
    await project.loadVariables();
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    runningId.value = null;
  }
}

async function removeSource(s: ExternalSource) {
  const ok = await confirm({
    title: `Delete “${s.name}”?`,
    message: 'Polling stops immediately. Already-ingested device data stays.',
  });
  if (!ok) return;
  try {
    await project.deleteExternalSource(s.id);
    toast.success('External source deleted');
  } catch (e) {
    toast.error((e as Error).message);
  }
}
</script>

<template>
  <div>
    <div class="mb-4 flex items-center justify-between">
      <div>
        <h2 class="text-sm font-semibold text-neutral-900 dark:text-neutral-100">API External</h2>
        <p class="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
          Poll a JSON URL on a schedule into one device. Invalid readings (null, sentinels) are kept as-is so dead sensors stay visible.
        </p>
      </div>
      <button
        type="button"
        class="shrink-0 rounded-md bg-accent-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent-700"
        @click="openCreate"
      >Add source</button>
    </div>

    <ExternalSourceDialog
      v-if="dialogOpen"
      :key="editing?.id ?? 'new'"
      :source="editing"
      @saved="closeDialog"
      @cancel="closeDialog"
    />

    <div v-if="loading" class="space-y-3" aria-busy="true">
      <div class="animate-pulse rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
        <div class="h-4 w-1/3 rounded bg-neutral-200 dark:bg-neutral-800"></div>
        <div class="mt-2 h-3 w-2/3 rounded bg-neutral-100 dark:bg-neutral-800/60"></div>
      </div>
      <p class="text-xs text-neutral-500 dark:text-neutral-400">Loading external sources…</p>
    </div>
    <div v-else-if="loadError" class="rounded-xl border border-red-300 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/30">
      <p class="text-xs font-semibold text-red-700 dark:text-red-300">Could not load external sources</p>
      <p class="mt-1 text-xs text-red-600 dark:text-red-400">{{ loadError }}</p>
      <button type="button" class="mt-2 rounded-md border border-red-300 px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-900/40" @click="retryLoad">Try again</button>
    </div>
    <div v-else-if="project.externalSources.length" class="space-y-3">
      <div
        v-for="s in project.externalSources"
        :key="s.id"
        class="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"
      >
        <div class="flex flex-wrap items-start gap-3">
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{{ s.name }}</span>
              <span class="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[11px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">{{ s.device_key }}</span>
              <span class="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[11px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">every {{ s.interval_minutes }}m</span>
            </div>
            <div class="mt-1 truncate font-mono text-[11px] text-neutral-500 dark:text-neutral-400">{{ s.url }}</div>
            <div class="mt-1 text-xs" :class="statusTone(s)">{{ statusLabel(s) }}</div>
          </div>
          <div class="flex shrink-0 flex-wrap items-center gap-2">
            <button
              type="button"
              class="rounded-md border border-neutral-300 px-2.5 py-1.5 text-xs font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
              :disabled="runningId === s.id"
              @click="pollNow(s)"
            >{{ runningId === s.id ? 'Polling…' : 'Poll now' }}</button>
            <button
              type="button"
              class="rounded-md border border-neutral-300 px-2.5 py-1.5 text-xs font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
              @click="toggleEnabled(s)"
            >{{ s.enabled ? 'Disable' : 'Enable' }}</button>
            <button
              type="button"
              class="rounded-md border border-neutral-300 px-2.5 py-1.5 text-xs font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
              @click="openEdit(s)"
            >Edit</button>
            <button
              type="button"
              class="rounded-md border border-red-300 px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950/40"
              @click="removeSource(s)"
            >Delete</button>
          </div>
        </div>
      </div>
    </div>
    <div v-else class="rounded-xl border border-dashed border-neutral-300 bg-white p-8 text-center dark:border-neutral-700 dark:bg-neutral-900">
      <div class="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-full bg-accent-50 text-accent-700 dark:bg-accent-900/30 dark:text-accent-300">
        <Icon :path="EMPTY_ICON" class="h-5 w-5" />
      </div>
      <h2 class="text-sm font-semibold text-neutral-900 dark:text-neutral-100">No external sources yet</h2>
      <p class="mx-auto mt-1 max-w-md text-xs text-neutral-500 dark:text-neutral-400">
        Add a JSON URL (e.g. https://biru-langit.com/api/TULT/2m), test it, tick the fields, and the worker polls it into a device.
      </p>
    </div>
  </div>
</template>
