"use strict";
/* Icons (Lucide, ISC licence) used by the trader screens. tpIcon("pencil") returns inline SVG. */
const TP_ICONS = {
 "arrow-left": "<path d=\"m12 19-7-7 7-7\"/> <path d=\"M19 12H5\"/>",
 "settings": "<path d=\"M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915\"/> <circle cx=\"12\" cy=\"12\" r=\"3\"/>",
 "plus": "<path d=\"M5 12h14\"/> <path d=\"M12 5v14\"/>",
 "chart-no-axes-combined": "<path d=\"M12 16v5\"/> <path d=\"M16 14.639V21\"/> <path d=\"M20 10.656V21\"/> <path d=\"m22 3-8.646 8.646a.5.5 0 0 1-.708 0L9.354 8.354a.5.5 0 0 0-.707 0L2 15\"/> <path d=\"M4 18.463V21\"/> <path d=\"M8 14.656V21\"/>",
 "grid-2x2": "<path d=\"M12 3v18\"/> <path d=\"M3 12h18\"/> <rect x=\"3\" y=\"3\" width=\"18\" height=\"18\" rx=\"2\"/>",
 "search": "<path d=\"m21 21-4.34-4.34\"/> <circle cx=\"11\" cy=\"11\" r=\"8\"/>",
 "x": "<path d=\"M18 6 6 18\"/> <path d=\"m6 6 12 12\"/>",
 "sliders-horizontal": "<path d=\"M10 5H3\"/> <path d=\"M12 19H3\"/> <path d=\"M14 3v4\"/> <path d=\"M16 17v4\"/> <path d=\"M21 12h-9\"/> <path d=\"M21 19h-5\"/> <path d=\"M21 5h-7\"/> <path d=\"M8 10v4\"/> <path d=\"M8 12H3\"/>",
 "pencil": "<path d=\"M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z\"/> <path d=\"m15 5 4 4\"/>",
 "package": "<path d=\"M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z\"/> <path d=\"M12 22V12\"/> <polyline points=\"3.29 7 12 12 20.71 7\"/> <path d=\"m7.5 4.27 9 5.15\"/>",
 "truck": "<path d=\"M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2\"/> <path d=\"M15 18H9\"/> <path d=\"M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14\"/> <circle cx=\"17\" cy=\"18\" r=\"2\"/> <circle cx=\"7\" cy=\"18\" r=\"2\"/>",
 "circle-check": "<circle cx=\"12\" cy=\"12\" r=\"10\"/> <path d=\"m16 9-5.5 5.5L8 12\"/>",
 "store": "<path d=\"M15 21v-5a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v5\"/> <path d=\"M17.774 10.31a1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.451 0 1.12 1.12 0 0 0-1.548 0 2.5 2.5 0 0 1-3.452 0 1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.77-3.248l2.889-4.184A2 2 0 0 1 7 2h10a2 2 0 0 1 1.653.873l2.895 4.192a2.5 2.5 0 0 1-3.774 3.244\"/> <path d=\"M4 10.95V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8.05\"/>",
 "qr-code": "<rect width=\"5\" height=\"5\" x=\"3\" y=\"3\" rx=\"1\"/> <rect width=\"5\" height=\"5\" x=\"16\" y=\"3\" rx=\"1\"/> <rect width=\"5\" height=\"5\" x=\"3\" y=\"16\" rx=\"1\"/> <path d=\"M21 16h-3a2 2 0 0 0-2 2v3\"/> <path d=\"M21 21v.01\"/> <path d=\"M12 7v3a2 2 0 0 1-2 2H7\"/> <path d=\"M3 12h.01\"/> <path d=\"M12 3h.01\"/> <path d=\"M12 16v.01\"/> <path d=\"M16 12h1\"/> <path d=\"M21 12v.01\"/> <path d=\"M12 21v-1\"/>",
 "user-round-plus": "<path d=\"M2 21a8 8 0 0 1 13.292-6\"/> <circle cx=\"10\" cy=\"8\" r=\"5\"/> <path d=\"M19 16v6\"/> <path d=\"M22 19h-6\"/>",
 "user-round-check": "<path d=\"M2 21a8 8 0 0 1 13.292-6\"/> <circle cx=\"10\" cy=\"8\" r=\"5\"/> <path d=\"m16 19 2 2 4-4\"/>",
 "message-circle": "<path d=\"M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719\"/>",
 "share-2": "<circle cx=\"18\" cy=\"5\" r=\"3\"/> <circle cx=\"6\" cy=\"12\" r=\"3\"/> <circle cx=\"18\" cy=\"19\" r=\"3\"/> <line x1=\"8.59\" x2=\"15.42\" y1=\"13.51\" y2=\"17.49\"/> <line x1=\"15.41\" x2=\"8.59\" y1=\"6.51\" y2=\"10.49\"/>",
 "shield-check": "<path d=\"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z\"/> <path d=\"m9 12 2 2 4-4\"/>",
 "chevron-down": "<path d=\"m6 9 6 6 6-6\"/>",
 "image": "<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\" ry=\"2\"/> <circle cx=\"9\" cy=\"9\" r=\"2\"/> <path d=\"m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21\"/>",
 "badge-check": "<path d=\"M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z\"/> <path d=\"m16 9-5.5 5.5L8 12\"/>"
};
function tpIcon(name, size = 18) {
  return `<svg class="tp-i" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TP_ICONS[name] || ""}</svg>`;
}
