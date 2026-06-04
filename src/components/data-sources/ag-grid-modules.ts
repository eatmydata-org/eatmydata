/**
 * AG-Grid v33+ requires explicit module registration. We register the
 * community-all bundle once at import time so the wrapper doesn't have
 * to do it. This module is side-effect: importing it is the
 * registration. Kept in its own file so HMR doesn't re-register on
 * every grid mount.
 */
import { ModuleRegistry, AllCommunityModule } from 'ag-grid-community';

ModuleRegistry.registerModules([AllCommunityModule]);
