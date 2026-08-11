<script setup lang="ts">
import { type HTMLAttributes } from 'vue';
import { cn } from '../../lib/utils';

defineOptions({ inheritAttrs: false });

interface Props {
  class?: HTMLAttributes['class'];
  modelValue?: string | number;
  ariaLabel?: string;
}

const props = defineProps<Props>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
</script>

<template>
  <select
    v-bind="$attrs"
    :value="props.modelValue"
    :aria-label="props.ariaLabel"
    :class="cn('narada-select', props.class)"
    @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
  >
    <slot />
  </select>
</template>
