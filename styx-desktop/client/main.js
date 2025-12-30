// Styx Client Entry Point
// This file imports modules and the legacy app.js

// Import modules (will be tree-shaken if unused)
import * as core from './modules/core.js';
import * as ui from './modules/ui.js';
import * as settings from './modules/settings.js';
import * as audio from './modules/audio.js';
import * as recording from './modules/recording.js';
import * as network from './modules/network.js';

// Expose modules globally for gradual migration
window.styxModules = { core, ui, settings, audio, recording, network };

// Legacy app.js will be loaded via script tag (non-module)
// Once migration is complete, we can import it here instead
