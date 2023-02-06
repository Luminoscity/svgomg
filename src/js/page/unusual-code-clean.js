export function removeUnusualAttributes(svgText) {
  if (document.readyState === 'loading') return svgText;

  const unusualAttributes = [
    'shape-margin',
    'inline-size',
    'isolation',
    'mix-blend-mode',
  ];

  const svg = document.createElement('html');
  svg.innerHTML = svgText;
  const paths = svg.querySelectorAll('path');
  const gs = svg.querySelectorAll('g');
  for (const a of unusualAttributes) {
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
