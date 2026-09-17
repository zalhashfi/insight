<script setup lang="ts">
import { computed, ref } from 'vue';
import { useProjectStore } from '../stores/project';
import { toast } from '../lib/toast';
import Dropdown from './Dropdown.vue';

const emit = defineEmits<{
  close: [];
}>();

const project = useProjectStore();

const file = ref<File | null>(null);
const version = ref('');
const notes = ref('');
const target = ref('esp32:esp32:esp32');
const uploading = ref(false);

const TARGET_OPTIONS = [
  { value: 'esp32:esp32:esp32', label: 'ESP32' },
  { value: 'esp32:esp32:esp32s3', label: 'ESP32-S3' },
  { value: 'esp32:esp32:esp32c3', label: 'ESP32-C3' },
  { value: 'esp8266:esp8266:nodemcuv2', label: 'ESP8266 (NodeMCU)' },
];

function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  if (f) {
    file.value = f;
    // Pre-seed version if empty from filename (e.g. fw-1.0.0.bin -> 1.0.0)
    if (!version.value.trim()) {
      const base = f.name.replace(/\.bin$/i, '').replace(/^[a-zA-Z_-]+/, '');
      if (base) version.value = base;
    }
  }
}

const canSubmit = computed(() => {
  return file.value !== null && version.value.trim().length > 0 && !uploading.value;
});

async function submit() {
  if (!file.value || !version.value.trim() || uploading.value) return;

  uploading.value = true;
  try {
    const fw = await project.uploadFirmware(
      file.value,
      version.value.trim(),
      notes.value.trim() || undefined,
      target.value || undefined
    );
    toast.success(`Firmware ${fw.version} uploaded successfully`);
    emit('close');
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    uploading.value = false;
  }
}
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/40 px-4 dark:bg-black/70"
    @click.self="emit('close')"
  >
    <div
      class="flex max-h-[90dvh] w-full max-w-md flex-col overflow-hidden rounded-xl bg-white shadow-xl dark:bg-neutral-900 dark:ring-1 dark:ring-neutral-800"
    >
      <header
        class="flex items-center justify-between border-b border-neutral-100 px-5 py-3 dark:border-neutral-800"
      >
        <div class="min-w-0">
          <h2 class="text-sm font-semibold leading-tight text-neutral-900 dark:text-neutral-100">
            Upload firmware binary
          </h2>
          <p class="mt-0.5 truncate text-[11px] text-neutral-500 dark:text-neutral-400">
            Upload a compiled .bin to release as an OTA update or flash over USB.
          </p>
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

      <form class="space-y-4 overflow-y-auto px-5 py-4 text-xs" @submit.prevent="submit">
        <!-- File input -->
        <div>
          <label class="block font-medium text-neutral-700 dark:text-neutral-300">
            Firmware binary (.bin) <span class="text-red-500">*</span>
          </label>
          <input
            type="file"
            accept=".bin"
            required
            class="mt-1.5 block w-full text-xs text-neutral-600 file:mr-3 file:rounded-md file:border-0 file:bg-neutral-100 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-neutral-700 hover:file:bg-neutral-200 dark:text-neutral-400 dark:file:bg-neutral-800 dark:file:text-neutral-200 dark:hover:file:bg-neutral-700"
            @change="onFileChange"
          />
          <p v-if="file" class="mt-1 text-[11px] text-neutral-400">
            {{ file.name }} ({{ Math.round(file.size / 1024) }} kB)
          </p>
        </div>

        <!-- Version field -->
        <div>
          <label class="block font-medium text-neutral-700 dark:text-neutral-300">
            Version label <span class="text-red-500">*</span>
          </label>
          <input
            v-model="version"
            type="text"
            required
            placeholder="e.g. 1.0.0 or v2.1-rc1"
            class="mt-1.5 w-full rounded-md border border-neutral-300 bg-white px-3 py-1.5 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
          />
          <p class="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400">
            Letters, numbers, dots, dashes, and underscores. Devices will compare their running version against this.
          </p>
        </div>

        <!-- Target chip -->
        <div>
          <label class="block font-medium text-neutral-700 dark:text-neutral-300">Target chip</label>
          <div class="mt-1.5">
            <Dropdown v-model="target" :options="TARGET_OPTIONS" size="sm" class="w-full" />
          </div>
        </div>

        <!-- Notes -->
        <div>
          <label class="block font-medium text-neutral-700 dark:text-neutral-300">Release notes</label>
          <textarea
            v-model="notes"
            rows="2"
            placeholder="Optional changelog or build notes"
            class="mt-1.5 w-full rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
          ></textarea>
        </div>

        <div class="flex items-center justify-end gap-2 pt-2 border-t border-neutral-100 dark:border-neutral-800">
          <button
            type="button"
            class="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
            @click="emit('close')"
          >
            Cancel
          </button>
          <button
            type="submit"
            :disabled="!canSubmit"
            class="rounded-md bg-accent-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-accent-700 disabled:opacity-50"
          >
            {{ uploading ? 'Uploading…' : 'Upload and release' }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
