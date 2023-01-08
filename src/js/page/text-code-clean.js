export function removeUnusedTextCode(svgText) {
  if (document.readyState === 'loading') return svgText;

  const fontAttributes = [
    'font-style',
    'font-variant',
    'font-weight',
    'font-stretch',
    'font-size',
    'line-height',
    'font-family',
    'text-align',
    'letter-spacing',
    'word-spacing',
    'writing-mode',
    'text-anchor',
    '-inkscape-font-specification',
  ];

  const svg = document.createElement('html');
  svg.innerHTML = svgText;
  const paths = svg.querySelectorAll('path');
  for (const path of paths) {
    for (const a of fontAttributes) {
      path.style.removeProperty(a);
      path.removeAttribute(a);
    }
  }

  return svg.querySelectorAll('svg')[0].outerHTML;
}
