<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api } from '../api';
import Dropdown from './Dropdown.vue';
import Spinner from './Spinner.vue';
import type { Device, Project, Variable } from '../types';

const props = defineProps<{
  project: Project;
}>();

const emit = defineEmits<{
  close: [];
}>();

const loading = ref(true);
const variables = ref<Variable[]>([]);
const devices = ref<Device[]>([]);

function formatDateTimeLocal(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const min = pad(date.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

const now = new Date();
const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

const fromStr = ref(formatDateTimeLocal(yesterday));
const toStr = ref(formatDateTimeLocal(now));

function setLast24Hours() {
  const n = new Date();
  toStr.value = formatDateTimeLocal(n);
  fromStr.value = formatDateTimeLocal(new Date(n.getTime() - 24 * 60 * 60 * 1000));
}

function setLast7Days() {
  const n = new Date();
  toStr.value = formatDateTimeLocal(n);
  fromStr.value = formatDateTimeLocal(new Date(n.getTime() - 7 * 24 * 60 * 60 * 1000));
}

const allVars = ref(true);
const selectedVars = ref<Set<string>>(new Set());

function toggleVariable(key: string) {
  const next = new Set(selectedVars.value);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  selectedVars.value = next;
  if (next.size > 0) {
    allVars.value = false;
  }
}

function toggleAllVars() {
  allVars.value = !allVars.value;
  if (allVars.value) {
    selectedVars.value = new Set();
  }
}

const selectedDevice = ref<string>('');
const format = ref<'long' | 'wide'>('long');

const formatOptions: { value: 'long' | 'wide'; label: string }[] = [
  { value: 'long', label: 'Long (one row per point)' },
  { value: 'wide', label: 'Wide (one row per timestamp)' },
];

const deviceOptions = computed(() => [
  { value: '', label: 'All devices' },
  ...devices.value.map((d) => ({
    value: d.id,
    label: d.is_default ? `${d.name} (default)` : d.name,
  })),
]);

const fromSec = computed(() => Math.floor(new Date(fromStr.value).getTime() / 1000));
const toSec = computed(() => Math.floor(new Date(toStr.value).getTime() / 1000));

const MAX_SPAN_SECONDS = 31 * 24 * 60 * 60; // 31 days

const rangeError = computed<string | null>(() => {
  if (!Number.isFinite(fromSec.value) || !Number.isFinite(toSec.value)) {
    return 'Invalid date range';
  }
  if (fromSec.value >= toSec.value) {
    return 'Start time must be before end time';
  }
  if (toSec.value - fromSec.value > MAX_SPAN_SECONDS) {
    return 'Range exceeds maximum allowed span of 31 days';
  }
  return null;
});

const canExport = computed(() => {
  if (rangeError.value) return false;
  if (!allVars.value && selectedVars.value.size === 0) return false;
  return true;
});

function exportData() {
  if (!canExport.value) return;

  const params = new URLSearchParams();
  params.set('from', String(fromSec.value));
  params.set('to', String(toSec.value));
  params.set('format', format.value);

  if (!allVars.value && selectedVars.value.size > 0) {
    params.set('vars', Array.from(selectedVars.value).join(','));
  }

  if (selectedDevice.value) {
    params.set('device', selectedDevice.value);
  }

  window.location.href = `/v1/admin/projects/${props.project.id}/export.csv?${params.toString()}`;
  emit('close');
}

onMounted(async () => {
  loading.value = true;
  try {
    const [varsRes, devsRes] = await Promise.all([
      api.get<{ variables: Variable[] }>(`/v1/admin/projects/${props.project.id}/variables`),
      api.get<{ devices: Device[] }>(`/v1/admin/projects/${props.project.id}/devices`),
    ]);
    variables.value = varsRes.variables;
    devices.value = devsRes.devices;
  } catch {
    variables.value = [];
    devices.value = [];
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/40 px-4 dark:bg-black/70"
    @click.self="emit('close')"
  >
    <div
      class="flex max-h-[90dvh] w-full max-w-lg flex-col overflow-hidden rounded-xl bg-white shadow-xl dark:bg-neutral-900 dark:ring-1 dark:ring-neutral-800"
    >
      <header
        class="flex items-center justify-between border-b border-neutral-100 px-5 py-3 dark:border-neutral-800"
      >
        <div>
          <div class="text-sm font-semibold">Export CSV</div>
          <div class="mt-0.5 truncate text-[11px] text-neutral-500 dark:text-neutral-400">
            {{ project.name }}
          </div>
        </div>
        <button
          type="button"
          class="-mr-1 rounded-md p-1 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
          aria-label="Close"
          @click="emit('close')"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            class="h-4 w-4"
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </header>

      <div v-if="loading" class="flex flex-1 items-center justify-center py-12">
        <Spinner size="sm" label="Loading project data…" />
      </div>

      <div v-else class="flex-1 space-y-4 overflow-y-auto px-5 py-4 text-xs">
        <!-- Range -->
        <div>
          <div class="flex items-center justify-between">
            <label class="block font-medium text-neutral-700 dark:text-neutral-300">Time range</label>
            <div class="flex items-center gap-1.5">
              <button
                type="button"
                class="rounded border border-neutral-200 px-1.5 py-0.5 text-[10px] text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800"
                @click="setLast24Hours"
              >
                Last 24h
              </button>
              <button
                type="button"
                class="rounded border border-neutral-200 px-1.5 py-0.5 text-[10px] text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800"
                @click="setLast7Days"
              >
                Last 7d
              </button>
            </div>
          </div>
          <div class="mt-1.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <span class="text-[10px] text-neutral-400">From</span>
              <input
                v-model="fromStr"
                type="datetime-local"
                class="mt-0.5 w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-xs text-neutral-800 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-200"
              />
            </div>
            <div>
              <span class="text-[10px] text-neutral-400">To</span>
              <input
                v-model="toStr"
                type="datetime-local"
                class="mt-0.5 w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-xs text-neutral-800 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-200"
              />
            </div>
          </div>
          <p v-if="rangeError" class="mt-1 text-[11px] text-red-600 dark:text-red-400">
            {{ rangeError }}
          </p>
        </div>

        <!-- Format -->
        <div>
          <label class="block font-medium text-neutral-700 dark:text-neutral-300">Layout</label>
          <div class="mt-1.5">
            <Dropdown v-model="format" :options="formatOptions" size="sm" class="w-full" />
          </div>
        </div>

        <!-- Device filter -->
        <div>
          <label class="block font-medium text-neutral-700 dark:text-neutral-300">Device</label>
          <div class="mt-1.5">
            <Dropdown v-model="selectedDevice" :options="deviceOptions" size="sm" class="w-full" />
          </div>
        </div>

        <!-- Variables selection -->
        <div>
          <div class="flex items-center justify-between">
            <label class="block font-medium text-neutral-700 dark:text-neutral-300">Variables</label>
            <button
              type="button"
              class="text-[10px] text-accent-600 hover:underline dark:text-accent-400"
              @click="toggleAllVars"
            >
              {{ allVars ? 'Select specific' : 'Select all' }}
            </button>
          </div>

          <div class="mt-1.5 max-h-36 overflow-y-auto rounded-md border border-neutral-200 p-2 dark:border-neutral-800">
            <div v-if="variables.length === 0" class="py-2 text-center text-neutral-400">
              No variables found in this project
            </div>
            <div v-else class="space-y-1">
              <label
                class="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-neutral-50 dark:hover:bg-neutral-800/60"
              >
                <input
                  type="checkbox"
                  :checked="allVars"
                  class="rounded border-neutral-300 text-accent-600 focus:ring-accent-500 dark:border-neutral-700 dark:bg-neutral-900"
                  @change="toggleAllVars"
                />
                <span class="font-medium text-neutral-800 dark:text-neutral-200">All variables</span>
              </label>
              <label
                v-for="v in variables"
                :key="v.id"
                class="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-neutral-50 dark:hover:bg-neutral-800/60"
              >
                <input
                  type="checkbox"
                  :checked="allVars || selectedVars.has(v.key)"
                  class="rounded border-neutral-300 text-accent-600 focus:ring-accent-500 dark:border-neutral-700 dark:bg-neutral-900"
                  @change="toggleVariable(v.key)"
                />
                <span class="font-mono text-neutral-700 dark:text-neutral-300">{{ v.key }}</span>
                <span v-if="v.unit" class="text-neutral-400">({{ v.unit }})</span>
              </label>
            </div>
          </div>
        </div>
      </div>

      <footer
        class="flex items-center justify-end gap-2 border-t border-neutral-100 px-5 py-3 dark:border-neutral-800"
      >
        <button
          type="button"
          class="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          @click="emit('close')"
        >
          Cancel
        </button>
        <button
          type="button"
          :disabled="!canExport || loading"
          class="rounded-md bg-accent-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent-700 disabled:opacity-50"
          @click="exportData"
        >
          Download CSV
        </button>
      </footer>
    </div>
  </div>
</template>
