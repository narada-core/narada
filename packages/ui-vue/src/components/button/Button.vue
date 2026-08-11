<script setup lang="ts">
import { type ButtonHTMLAttributes, type HTMLAttributes } from 'vue';
import { cn } from '../../lib/utils';

defineOptions({ inheritAttrs: false });

interface Props {
  class?: HTMLAttributes['class'];
  type?: ButtonHTMLAttributes['type'];
  variant?: 'primary' | 'secondary' | 'quiet';
  disabled?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  type: 'button',
  variant: 'primary',
  disabled: false,
});
</script>

<template>
  <button
    v-bind="$attrs"
    :type="props.type"
    :disabled="props.disabled"
    :data-variant="props.variant"
    :class="cn('narada-button', props.class)"
  >
    <slot />
  </button>
</template>
