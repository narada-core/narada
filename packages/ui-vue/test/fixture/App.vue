<script setup lang="ts">
import {
  Button,
  Command,
  CommandEmpty,
  CommandItem,
  CommandList,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  Select,
} from '@narada-core/ui-vue';
</script>

<template>
  <Button>Primary action</Button>
  <Select aria-label="Playback speed" model-value="1">
    <option value="1">1×</option>
    <option value="2">2×</option>
  </Select>

  <TooltipProvider>
    <Tooltip>
      <TooltipTrigger as-child>
        <button type="button">Help</button>
      </TooltipTrigger>
      <TooltipContent>Shared tooltip</TooltipContent>
    </Tooltip>
  </TooltipProvider>

  <Command>
    <CommandList label="Actions">
      <CommandItem option-id="action-one" :active="true">Action one</CommandItem>
      <CommandEmpty>No actions</CommandEmpty>
    </CommandList>
  </Command>

  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <button type="button">Open menu</button>
    </DropdownMenuTrigger>
    <DropdownMenuContent>
      <DropdownMenuItem>Menu item</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>