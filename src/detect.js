const PT_WORDS = new Set(
  ('não nao que de para pra com uma um você voce é está esta isso isto como mais ' +
    'também tambem quero preciso fazer pode poderia arquivo código codigo função funcao ' +
    'quando onde porque então entao mas ou os as dos das no na nos nas pelo pela seu sua ' +
    'meu minha esse essa este aqui ainda já ja sem muito todo toda tudo deve')
    .split(' '),
);
const EN_WORDS = new Set(
  ('the and to of is are was this that with for you your it in on be can could would ' +
    'should please make file code function when where because then but or not what how ' +
    'all any do does my we they have has will just')
    .split(' '),
);

// Returns 'pt', 'en' or 'other'.
export function detectLanguage(text) {
  const words = text.toLowerCase().match(/[\p{L}]+/gu) || [];
  if (words.length === 0) return 'other';
  let pt = 0;
  let en = 0;
  for (const w of words) {
    if (PT_WORDS.has(w)) pt++;
    if (EN_WORDS.has(w)) en++;
  }
  pt += (text.match(/[ãõçáéíóúâêôà]/gi) || []).length * 0.5;
  if (pt === 0 && en === 0) return 'other';
  if (pt > en * 1.2) return 'pt';
  if (en > pt * 1.2) return 'en';
  return 'other';
}
