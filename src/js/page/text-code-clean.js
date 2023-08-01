export function removeUnusedTextCode(svgText) {
  if (document.readyState === 'loading') return svgText;

  const fontAttributes = [
    'font-style',
    'font-variant',
    'font-weight',
    'font-stretch',
    'font-size',
    'font-family',
    'line-height',
    'letter-spacing',
    'word-spacing',
    'writing-mode',
    'white-space',
    'text-align',
    'text-anchor',
    'text-indent',
    'text-transform',
    'text-orientation',
    'text-decoration-color',
    'text-decoration-line',
    'text-decoration-style',
    'text-decoration-style',
    'text-decoration-thickness',
    'font-variant',
    'font-variant-east-asian',
    'font-variant-ligatures',
    'font-variant-caps',
    'font-variant-numeric',
    'font-feature-settings',
    'font-variant-position',
    'font-variant-alternates',
    'font-variation-settings',
    '-inkscape-stroke',
    '-inkscape-font-specification',
  ];

  const svg = document.createElement('html');
  svg.innerHTML = svgText;
  const paths = svg.querySelectorAll('path');
  const gs = svg.querySelectorAll('g');
  for (const a of fontAttributes) {
    for (const path of paths) {
      path.style.removeProperty(a);
      path.removeAttribute(a);
    }

    for (const group of gs) {
      group.style.removeProperty(a);
      group.removeAttribute(a);
    }
  }

  return svg.querySelectorAll('svg')[0].outerHTML;
}
