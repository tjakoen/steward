// Shared renderer: expands GRAIN <b-*> component tags in pages/fragments.

import { createRenderer } from '@tjakoen/batch/render/render.ts';
import { config } from './config.ts';
import { componentRoots } from './app/assets/components.ts';

export const { render, renderPage, refresh } = createRenderer({
  // The source roots from a checkout; a materialised directory in a binary, because the
  // renderer discovers templates with a directory walk. See app/assets/components.ts.
  componentsDir: componentRoots(config.componentRoots),
  missing: config.missingBindings,
});
