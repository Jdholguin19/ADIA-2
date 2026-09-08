// Regresion de navegacion entre pestañas.
//
// El fallo original: con rutas PLANAS y DatasetShell renderizado dentro de
// cada hoja, un NavLink relativo resolvia contra la pestaña activa. Desde
// /d/1/chat, "alertas" daba /d/1/chat/alertas, que no existe, caia en
// path="*" y te devolvia al inicio. Pulsar dos veces la misma pestaña hacia
// lo mismo (/d/1/chat/chat).
//
// Se renderizan los NavLink REALES (importados de src/nav.ts) dentro de la
// misma estructura anidada que usa App.tsx y se comprueban los href desde
// cada pestaña. Sin navegador.
//
//   npm run test:routes
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, NavLink, Outlet, useRoutes } from 'react-router-dom'
import { DATASET_TABS, DATASET_CHILD_PATHS } from '../src/nav.ts'

// react-router usa useLayoutEffect y avisa en cada render de servidor. Es
// ruido esperado aqui: solo se miran los href generados.
const _warn = console.error
console.error = (...a) => {
  if (typeof a[0] === 'string' && a[0].includes('useLayoutEffect')) return
  _warn(...a)
}

const ID = '1'
let pass = 0, fail = 0
const ok = (m) => { console.log('  OK   ' + m); pass++ }
const no = (m, d) => { console.log('  FALLA ' + m + '\n        ' + d); fail++ }

// Replica de DatasetShell: solo la barra de pestañas y el Outlet.
function Shell() {
  return h(
    'nav', null,
    ...DATASET_TABS.map((t) =>
      h(NavLink, { key: t.to, to: t.to, end: t.end, 'data-tab': t.label }, t.label)),
    h(Outlet, null),
  )
}

const routes = [
  { path: '/', element: h('div', null, 'lista') },
  {
    path: '/d/:id',
    element: h(Shell),
    children: [
      { index: true, element: h('div', null, 'tablero') },
      ...DATASET_CHILD_PATHS.map((p) => ({ path: p, element: h('div', null, p) })),
    ],
  },
  { path: '*', element: h('div', null, 'FALLBACK-INICIO') },
]

const Router = () => useRoutes(routes)

function render(pathname) {
  return renderToStaticMarkup(
    h(MemoryRouter, { initialEntries: [pathname] }, h(Router)),
  )
}

function hrefs(html) {
  return [...html.matchAll(/<a[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)]
    .map((m) => ({ href: m[1], label: m[2] }))
}

// Todas las pestañas, desde todas las pestañas, deben apuntar a la ruta
// absoluta correcta.
// Derivado de DATASET_TABS, no escrito a mano: al quitar o anadir una
// pestaña el test se ajusta solo en vez de fallar por desincronizacion.
const esperado = new Map(
  DATASET_TABS.map((t) => [t.label, t.to === '.' ? `/d/${ID}` : `/d/${ID}/${t.to}`]),
)

const desde = [`/d/${ID}`, ...DATASET_CHILD_PATHS.map((p) => `/d/${ID}/${p}`)]

console.log('== Los enlaces de pestaña resuelven igual desde cualquier pestaña ==')
for (const loc of desde) {
  const html = render(loc)
  if (html.includes('FALLBACK-INICIO')) {
    no(loc, 'la ruta no coincide con nada y cae en el fallback al inicio')
    continue
  }
  const links = hrefs(html)
  if (links.length !== DATASET_TABS.length) {
    no(loc, `se esperaban ${DATASET_TABS.length} enlaces, se encontraron ${links.length}`)
    continue
  }
  const malos = links.filter((l) => esperado.get(l.label) !== l.href)
  if (malos.length) {
    no(loc, malos.map((m) => `"${m.label}" -> ${m.href} (esperado ${esperado.get(m.label)})`).join('; '))
  } else {
    ok(`desde ${loc}: las ${DATASET_TABS.length} pestañas apuntan bien`)
  }
}

// Lo que fallaba antes: rutas anidadas de pestaña sobre pestaña.
console.log('\n== Las rutas mal formadas de antes ya no se generan ==')
for (const malo of [`/d/${ID}/chat/chat`, `/d/${ID}/chat/alertas`, `/d/${ID}/alertas/datos`]) {
  const html = render(malo)
  if (html.includes('FALLBACK-INICIO')) {
    ok(`${malo} sigue sin existir (por eso te mandaba al inicio)`)
  } else {
    no(malo, 'deberia no coincidir con ninguna ruta')
  }
}

// La pestaña activa se marca sola: aria-current lo confirma.
console.log('\n== Pestaña activa ==')
for (const [loc, etiqueta] of [
  [`/d/${ID}`, 'Tablero'],
  [`/d/${ID}/rag`, 'Configuración IA'],
]) {
  const html = render(loc)
  const m = [...html.matchAll(/<a[^>]*aria-current="page"[^>]*>([^<]*)<\/a>/g)].map((x) => x[1])
  if (m.length === 1 && m[0] === etiqueta) ok(`en ${loc} la activa es "${etiqueta}"`)
  else no(loc, `activas: ${JSON.stringify(m)}, se esperaba solo "${etiqueta}"`)
}

// ---------------------------------------------------------------------
// Tiene dientes esta prueba? Se reconstruye la estructura ANTIGUA (rutas
// planas, el shell dentro de cada hoja) y se exige que FALLE. Una prueba de
// regresion que pasa igual con el codigo roto no vale nada.
// ---------------------------------------------------------------------
console.log('')
console.log('== Comprobacion de que la prueba detecta el fallo antiguo ==')
const ShellViejo = ({ children }) =>
  h('nav', null,
    ...DATASET_TABS.map((t) =>
      h(NavLink, { key: t.to, to: t.to === '.' ? '' : t.to, end: t.end }, t.label)),
    children)

const rutasViejas = [
  { path: '/', element: h('div', null, 'lista') },
  { path: '/d/:id', element: h(ShellViejo, null, h('div', null, 'tablero')) },
  ...DATASET_CHILD_PATHS.map((p) => ({
    path: `/d/:id/${p}`, element: h(ShellViejo, null, h('div', null, p)),
  })),
  { path: '*', element: h('div', null, 'FALLBACK-INICIO') },
]
const RouterViejo = () => useRoutes(rutasViejas)
const htmlViejo = renderToStaticMarkup(
  h(MemoryRouter, { initialEntries: [`/d/${ID}/chat`] }, h(RouterViejo)))
// Cualquier pestaña que no sea la indice sirve; se toma la primera para no
// atarse a una etiqueta concreta que manana puede desaparecer.
const sonda = DATASET_TABS.find((t) => t.to !== '.')
const roto = hrefs(htmlViejo).find((l) => l.label === sonda.label)

if (roto && roto.href !== `/d/${ID}/${sonda.to}`) {
  ok(`la estructura antigua daba "${roto.href}" desde /d/${ID}/chat: la prueba lo detecta`)
} else {
  no('dientes de la prueba', `la estructura antigua dio ${JSON.stringify(roto)}; ` +
     'la prueba pasaria igual con el codigo roto y no serviria')
}

console.log(`\n${pass} correctas, ${fail} fallidas`)
if (fail) process.exitCode = 1
