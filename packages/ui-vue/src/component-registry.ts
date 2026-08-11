export const NARADA_UI_COMPONENT_REGISTRY_VERSION = 1 as const;

export type NaradaUiComponentMaturity = 'stable' | 'experimental';

export interface NaradaUiComponentFamily {
  id: string;
  exports: readonly string[];
  maturity: NaradaUiComponentMaturity;
  upstream: 'narada' | 'shadcn-vue/reka-ui';
  styles: '@narada-core/ui-vue/components.css';
  accessibility: readonly string[];
}

export const naradaUiComponentRegistry = [
  { id: 'button', exports: ['Button'], maturity: 'stable', upstream: 'narada', styles: '@narada-core/ui-vue/components.css', accessibility: ['native-button', 'focus-visible', 'disabled-state'] },
  { id: 'select', exports: ['Select'], maturity: 'stable', upstream: 'narada', styles: '@narada-core/ui-vue/components.css', accessibility: ['native-select', 'accessible-name', 'focus-visible'] },
  { id: 'command', exports: ['Command', 'CommandEmpty', 'CommandItem', 'CommandList'], maturity: 'stable', upstream: 'shadcn-vue/reka-ui', styles: '@narada-core/ui-vue/components.css', accessibility: ['keyboard-navigation', 'empty-state'] },
  { id: 'dialog', exports: ['Dialog', 'DialogClose', 'DialogContent', 'DialogDescription', 'DialogFooter', 'DialogHeader', 'DialogTitle', 'DialogTrigger'], maturity: 'stable', upstream: 'shadcn-vue/reka-ui', styles: '@narada-core/ui-vue/components.css', accessibility: ['focus-trap', 'escape-dismissal', 'label-and-description'] },
  { id: 'dropdown-menu', exports: ['DropdownMenu', 'DropdownMenuContent', 'DropdownMenuItem', 'DropdownMenuTrigger'], maturity: 'stable', upstream: 'shadcn-vue/reka-ui', styles: '@narada-core/ui-vue/components.css', accessibility: ['keyboard-navigation', 'focus-management'] },
  { id: 'operator-surface', exports: ['OperatorSurfaceShell'], maturity: 'experimental', upstream: 'narada', styles: '@narada-core/ui-vue/components.css', accessibility: ['landmark-navigation'] },
  { id: 'tooltip', exports: ['Tooltip', 'TooltipContent', 'TooltipProvider', 'TooltipTrigger'], maturity: 'stable', upstream: 'shadcn-vue/reka-ui', styles: '@narada-core/ui-vue/components.css', accessibility: ['keyboard-trigger', 'described-content'] },
] as const satisfies readonly NaradaUiComponentFamily[];
