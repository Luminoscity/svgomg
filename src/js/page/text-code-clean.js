export function removeUnusedTextCode(svgText) {
  if (document.readyState == 'loading') return svgText;
  console.log('removeUnusedTextCode');

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
    '-inkscape-font-specification'
  ];

  let svg = document.createElement('html');
  svg.innerHTML = svgText;
  let paths = svg.getElementsByTagName('path');
  console.log(`paths: ${paths.length}`);
  for (let path of paths) {
    fontAttributes.forEach(a => {
      path.style.removeProperty(a);
      path.removeAttribute(a);
    });
  }

  let el = svg.getElementsByTagName('svg')[0].outerHTML;
  return el;
}
