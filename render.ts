// Shared renderer: expands GRAIN <b-*> component tags in pages/fragments.

import { createRenderer } from '@tjakoen/batch/render/render.ts';
import { config } from './config.ts';

export const { render, renderPage, refresh } = createRenderer({
  componentsDir: [...config.componentRoots],
  missing: config.missingBindings,
});
