// ═══════════════════════════════════════════════════════════════════════════
// FACEBOOK SAVED — EXTRACTOR DOM → MESSENGER
// Version: 2.0.0
// Descripción: Extrae publicaciones de Facebook Saved y las copia a Messenger
// ═══════════════════════════════════════════════════════════════════════════

const DEBUG = true;

// ═══════════════════════════════════════════════════════════════════════════
// 1. ESTADO GLOBAL Y CONFIGURACIÓN
// ═══════════════════════════════════════════════════════════════════════════

class FacebookExtractorState {
  constructor() {
    this.estado = "DETENIDO";
    this.activo = false;
    this.detenido = false;
    
    // Buffer y posts
    this.buffer = []; // FIFO de posts a procesar
    this.postsConocidos = new Map(); // Deduplicación por post_id o URL
    this.postsEnviadosEnMensaje = new Set(); // Prevenir duplicación en Messenger
    
    // Estadísticas
    this.stats = {
      postsCargados: 0,
      postsNuevos: 0,
      postsCopiados: 0,
      postsPurgados: 0,
      domActualMB: 0,
      domAcumuladoMB: 0,
      domPurgadoMB: 0
    };
    
    // Objetivo
    this.objetivoId = null;
    this.objetivoEncontrado = false;
    this.postsPostObjetivo = 0;
    this.objetivoIndice = -1;
    
    // Lotes
    this.loteActual = [];
    this.loteEnProceso = false;
    this.loteConfirmado = false;
    
    // Timers
    this.scrollTimer = null;
    this.scanTimer = null;
    this.waitTimer = null;
    
    // DOM tracking
    this.ultimoScrollPost = null;
    this.crecimientoDetectado = false;
  }
  
  reset() {
    this.buffer = [];
    this.postsConocidos.clear();
    this.postsEnviadosEnMensaje.clear();
    this.stats = {
      postsCargados: 0,
      postsNuevos: 0,
      postsCopiados: 0,
      postsPurgados: 0,
      domActualMB: 0,
      domAcumuladoMB: 0,
      domPurgadoMB: 0
    };
    this.objetivoEncontrado = false;
    this.postsPostObjetivo = 0;
    this.loteActual = [];
  }
}

const state = new FacebookExtractorState();

// ═══════════════════════════════════════════════════════════════════════════
// 2. LOGGING Y DEBUGGING
// ═══════════════════════════════════════════════════════════════════════════

function log(categoria, mensaje, datos = null) {
  if (!DEBUG) return;
  const timestamp = new Date().toLocaleTimeString();
  const prefix = `[${timestamp}] [${categoria}]`;
  if (datos) {
    console.log(prefix, mensaje, datos);
  } else {
    console.log(prefix, mensaje);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. EXTRACCIÓN DE PUBLICACIONES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extrae post_id de URL de Facebook
 */
function extraerPostId(urlString) {
  if (!urlString) return "";
  
  // Formato: https://web.facebook.com/watch/?ref=saved&v=VIDEO_ID
  const matchVideo = urlString.match(/[?&]v=(\d+)/);
  if (matchVideo) return matchVideo[1];
  
  // Formato: https://www.facebook.com/user/posts/123456789
  const matchPost = urlString.match(/\/posts\/(\d+)/);
  if (matchPost) return matchPost[1];
  
  // Formato en href con post_id
  const matchHref = urlString.match(/post_id=(\d+)/);
  if (matchHref) return matchHref[1];
  
  return "";
}

/**
 * Normaliza y canonicaliza URL de publicación
 */
function normalizeUrl(urlString) {
  if (!urlString) return "";
  
  try {
    // Eliminar fbclid
    const url = new URL(urlString);
    url.searchParams.delete("fbclid");
    
    // Retornar URL canónica
    return url.toString();
  } catch (e) {
    return urlString;
  }
}

/**
 * Extrae autor limpio sin concatenación de interfaz
 */
function extraerAutor(nodoPost) {
  if (!nodoPost) return "";
  
  // Estrategia 1: Buscar span de autor específico
  const spanAutor = nodoPost.querySelector('a[href*="/"][role="link"]');
  if (spanAutor) {
    const texto = spanAutor.textContent.trim();
    // Validar que no sea texto de interfaz
    if (texto && 
        !texto.includes("Agregar a colección") && 
        !texto.includes("Se guardó") &&
        !texto.includes("Reels") &&
        texto.length > 0 && 
        texto.length < 100) {
      return texto;
    }
  }
  
  // Estrategia 2: Extraer de "Se guardó desde la publicación de AUTOR"
  const textoCompleto = nodoPost.textContent;
  const matchDesde = textoCompleto.match(/Se guardó desde la publicación de\s+([^\n]+?)(?:\n|Se guardó|Agregar|$)/i);
  if (matchDesde) {
    const autor = matchDesde[1].trim();
    if (autor && !autor.includes("Se guardó") && autor.length < 100) {
      return autor;
    }
  }
  
  return "";
}

/**
 * Extrae colección limpia sin concatenación
 */
function extraerColeccion(nodoPost) {
  if (!nodoPost) return "";
  
  // Buscar estructura: <a href="/saved/?list_id=..."><span>NombreColección</span></a>
  const linkColeccion = nodoPost.querySelector('a[href*="/saved/"]');
  if (linkColeccion) {
    const spanNombre = linkColeccion.querySelector('span');
    if (spanNombre) {
      const texto = spanNombre.textContent.trim();
      // Validar que sea nombre de colección limpio
      if (texto && 
          !texto.includes("Se guardó") && 
          !texto.includes("Reels") &&
          texto.length > 0 && 
          texto.length < 100) {
        return texto;
      }
    }
  }
  
  return "";
}

/**
 * Extrae tipo de publicación
 */
function extraerTipoPost(nodoPost) {
  if (!nodoPost) return "post_texto";
  
  // Detectar video (watch URL o video player)
  if (nodoPost.querySelector('a[href*="watch?"]') || 
      nodoPost.querySelector('[role="img"][aria-label*="video" i]')) {
    return "post_video";
  }
  
  // Detectar URL externa (enlace que no es de Facebook o redirección)
  const enlace = nodoPost.querySelector('a[href^="http"]');
  if (enlace) {
    const href = enlace.getAttribute('href');
    const urlObj = new URL(href);
    
    // Si es Facebook pero es redirección a URL externa
    if (href.includes('facebook.com') && href.includes('u=')) {
      return "post_url";
    }
    
    // Si es URL externa directa
    if (!href.includes('facebook.com')) {
      return "post_url";
    }
  }
  
  return "post_texto";
}

/**
 * Extrae texto completo sin truncamiento
 */
function extraerTexto(nodoPost) {
  if (!nodoPost) return "";
  
  // Buscar el contenedor de texto principal de la publicación
  // Evitar: autores, interfaz, timestamps, etc.
  
  // Estrategia: Buscar divs que contengan párrafos largos de texto
  const textDivs = nodoPost.querySelectorAll('div');
  let textoMasLargo = "";
  
  for (const div of textDivs) {
    // Excluir divs pequeños (probablemente interfaz)
    const children = div.children.length;
    if (children > 10) continue; // Probablemente contenedor de estructura
    
    const texto = div.textContent;
    
    // Excluir textos que sean interfaz
    if (texto.includes("Agregar a colección") || 
        texto.includes("Se guardó") ||
        texto.includes("Me gusta") ||
        texto.includes("Comentar")) {
      continue;
    }
    
    // Buscar el texto más largo y sustancial
    if (texto.length > textoMasLargo.length && texto.length < 10000) {
      textoMasLargo = texto;
    }
  }
  
  return textoMasLargo.trim();
}

/**
 * Extrae URL canónica de publicación
 */
function extraerUrl(nodoPost) {
  if (!nodoPost) return "";
  
  // Buscar enlace de share/permalink
  const enlace = nodoPost.querySelector('a[href*="web.facebook.com"]');
  if (enlace) {
    return normalizeUrl(enlace.getAttribute('href'));
  }
  
  const enlaceAlt = nodoPost.querySelector('a[href*="watch?"]');
  if (enlaceAlt) {
    return normalizeUrl(enlaceAlt.getAttribute('href'));
  }
  
  return "";
}

/**
 * Detecta si un post es un contenedor válido
 */
function esContenedorPostValido(elemento) {
  if (!elemento) return false;
  
  // Validar que tenga estructura de post
  // Debe tener autor, texto, o enlace
  const tieneAutor = elemento.querySelector('a[href*="/"]') !== null;
  const tieneTexto = elemento.textContent.length > 20;
  
  return tieneAutor && tieneTexto;
}

/**
 * Escanea y extrae publicaciones del DOM
 * ARQUITECTURA: Detecta posts nuevos por estructura, no por elemento contado
 */
function escanearPublicaciones() {
  log("SCAN", "Iniciando escaneo de publicaciones");
  
  // Buscar contenedores de publicaciones
  // Facebook Saved puede usar diferentes estructuras
  const posiblesContenedores = [
    ...document.querySelectorAll('[role="article"]'),
    ...document.querySelectorAll('div[id^="js_"]'), // Estructura interna FB
    ...document.querySelectorAll('article'),
    ...document.querySelectorAll('li[data-pagelet^="FeedItem"]')
  ];
  
  log("SCAN", `Contenedores encontrados: ${posiblesContenedores.length}`);
  
  let postsNuevosDetectados = 0;
  
  for (const contenedor of posiblesContenedores) {
    if (!esContenedorPostValido(contenedor)) continue;
    
    // Extraer ID único del post
    const postId = extraerPostId(extraerUrl(contenedor));
    const urlCanonica = normalizeUrl(extraerUrl(contenedor));
    
    // Generar clave de deduplicación
    const clave = postId || urlCanonica || contenedor.id;
    
    if (!clave) continue;
    
    // Validar si ya existe
    if (state.postsConocidos.has(clave)) {
      continue;
    }
    
    // Crear objeto de post
    const post = {
      id: state.stats.postsCargados + 1,
      post_id: postId,
      pfbid: "", // No siempre disponible
      page_or_user_id: "", // No siempre disponible
      group_id: "", // No siempre disponible
      autor: extraerAutor(contenedor),
      texto: extraerTexto(contenedor),
      coleccion: extraerColeccion(contenedor),
      tipo_post: extraerTipoPost(contenedor),
      url: extraerUrl(contenedor),
      timestamp: new Date().toISOString()
    };
    
    // Validar post mínimo
    if (!post.post_id && !post.url) continue;
    if (!post.autor && !post.texto) continue;
    
    // Agregar a deduplicación y buffer
    state.postsConocidos.set(clave, post);
    state.buffer.push(post);
    state.stats.postsCargados++;
    state.stats.postsNuevos++;
    postsNuevosDetectados++;
    
    log("POST", `Nuevo post detectado: ${post.post_id || post.url}`, post);
  }
  
  log("SCAN", `Posts nuevos en este escaneo: ${postsNuevosDetectados}`);
  
  if (postsNuevosDetectados > 0) {
    state.crecimientoDetectado = true;
  }
  
  return postsNuevosDetectados;
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. LÓGICA DE BUFFER Y LOTES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Obtiene un lote de 30 posts del buffer (FIFO)
 * Arquitectura: Siempre toma los primeros 30, mantiene orden
 */
function obtenerLote(cantidad = 30) {
  if (state.buffer.length < cantidad) {
    return null; // No hay suficientes posts
  }
  
  const lote = state.buffer.splice(0, cantidad);
  
  log("BATCH", `Lote generado: ${lote.length} posts`, {
    primero: lote[0].post_id || lote[0].url,
    ultimo: lote[lote.length - 1].post_id || lote[lote.length - 1].url,
    bufferRestante: state.buffer.length
  });
  
  return lote;
}

/**
 * Deduplica posts dentro de un lote
 */
function deduplicarLote(lote) {
  const visto = new Set();
  const deduplicado = [];
  
  for (const post of lote) {
    const clave = post.post_id || post.url;
    if (!clave || visto.has(clave)) continue;
    
    visto.add(clave);
    deduplicado.push(post);
  }
  
  if (deduplicado.length < lote.length) {
    log("BATCH", `Duplicados removidos: ${lote.length - deduplicado.length}`);
  }
  
  return deduplicado;
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. LÓGICA DE OBJETIVO
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Procesa la lógica de objetivo + 3 posteriores
 * RETORNA: {accion: "PROCESAR" | "ESPERAR", lote: [...]}
 */
function procesarObjetivo() {
  if (!state.objetivoId) {
    return { accion: "PROCESAR_NORMAL" };
  }
  
  log("OBJECTIVE", `Buscando objetivo: ${state.objetivoId}`);
  
  // Buscar objetivo en buffer
  let idxObjetivo = -1;
  for (let i = 0; i < state.buffer.length; i++) {
    if (state.buffer[i].post_id === state.objetivoId) {
      idxObjetivo = i;
      break;
    }
  }
  
  // Objetivo no encontrado aún
  if (idxObjetivo === -1) {
    log("OBJECTIVE", "Objetivo no encontrado aún en buffer");
    return { accion: "ESPERAR" };
  }
  
  log("OBJECTIVE", `Objetivo encontrado en índice ${idxObjetivo}`);
  state.objetivoEncontrado = true;
  state.objetivoIndice = idxObjetivo;
  
  // Verificar que existan los 3 posteriores
  const postsRequeridos = 4; // Objetivo + 3
  if (idxObjetivo + postsRequeridos > state.buffer.length) {
    log("OBJECTIVE", `Esperando 3 posts posteriores. Disponibles: ${state.buffer.length - idxObjetivo - 1}`);
    return { accion: "ESPERAR_POSTERIORES" };
  }
  
  // Extraer objetivo + 3 posteriores
  const lote = state.buffer.splice(idxObjetivo, postsRequeridos);
  
  log("OBJECTIVE", `Objetivo completado: ${postsRequeridos} posts extraídos`, {
    objetivo: lote[0].post_id,
    posteriores: lote.slice(1).map(p => p.post_id || p.url)
  });
  
  return {
    accion: "FIN_OBJETIVO",
    lote: lote
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. MESSENGER - LOCALIZACIÓN Y APERTURA
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Localiza el botón flotante INFERIOR de Messenger
 * Excluye: header, nav, elementos superiores
 */
function localizarBotonMessenger() {
  log("MESSENGER", "Buscando botón flotante Messenger");
  
  const candidatos = document.querySelectorAll('[role="button"], button, [aria-label*="Messenger" i]');
  
  let mejorCandidate = null;
  let mejorPuntaje = -Infinity;
  
  for (const elemento of candidatos) {
    const rect = elemento.getBoundingClientRect();
    let puntaje = 0;
    
    // PENALIZACIÓN: Elemento en header/nav (excluir superiores)
    if (elemento.closest('header, nav, [role="banner"]')) {
      puntaje -= 10000;
    }
    
    // BONIFICACIÓN: Proximidad a borde inferior (MAXIMIZAR)
    const distanciaAlFondo = window.innerHeight - rect.bottom;
    if (distanciaAlFondo > -50 && distanciaAlFondo < 100) {
      puntaje += 1000 - distanciaAlFondo;
    }
    
    // BONIFICACIÓN: Tamaño típico de botón flotante
    if (rect.width > 30 && rect.width < 100 && rect.height > 30 && rect.height < 100) {
      puntaje += 500;
    }
    
    // BONIFICACIÓN: Aria-label con "Messenger"
    if (elemento.getAttribute('aria-label')?.includes('Messenger')) {
      puntaje += 300;
    }
    
    // PENALIZACIÓN: Position no fixed/sticky
    const style = window.getComputedStyle(elemento);
    if (style.position === 'fixed' || style.position === 'sticky') {
      puntaje += 200;
    }
    
    // PENALIZACIÓN: Elemento muy grande (probablemente contenedor, no botón)
    if (rect.width > 200 || rect.height > 200) {
      puntaje -= 500;
    }
    
    if (puntaje > mejorPuntaje) {
      mejorPuntaje = puntaje;
      mejorCandidate = elemento;
    }
  }
  
  if (mejorCandidate && mejorPuntaje > -1000) {
    log("MESSENGER", "Botón flotante localizado", {
      puntaje: mejorPuntaje,
      position: mejorCandidate.getBoundingClientRect()
    });
    return mejorCandidate;
  }
  
  log("MESSENGER", "No se encontró botón flotante válido");
  return null;
}

/**
 * Abre Messenger pulsando botón flotante inferior
 */
async function abrirMessenger() {
  log("MESSENGER", "Iniciando apertura de Messenger");
  
  const boton = localizarBotonMessenger();
  if (!boton) {
    log("MESSENGER", "ERROR: No se encontró botón Messenger");
    return false;
  }
  
  boton.click();
  await new Promise(resolve => setTimeout(resolve, 2000)); // Esperar apertura
  
  log("MESSENGER", "Messenger abierto");
  return true;
}

/**
 * Localiza el chat "Fuego Vivo"
 */
function localizarChatFuegoVivo() {
  log("CHAT", "Buscando chat 'Fuego Vivo'");
  
  // Buscar todos los elementos que contengan nombres de chat
  const chats = document.querySelectorAll('[role="button"], div[aria-label*="" i], span');
  
  for (const elemento of chats) {
    if (elemento.textContent.trim() === "Fuego Vivo") {
      log("CHAT", "Chat 'Fuego Vivo' encontrado");
      return elemento;
    }
  }
  
  // Búsqueda alternativa: data attributes
  const chatAlt = document.querySelector('[data-tooltip*="Fuego Vivo"]');
  if (chatAlt) {
    log("CHAT", "Chat encontrado por data attribute");
    return chatAlt;
  }
  
  log("CHAT", "ERROR: Chat 'Fuego Vivo' no encontrado");
  return null;
}

/**
 * Abre el chat "Fuego Vivo"
 */
async function abrirChatFuegoVivo() {
  log("CHAT", "Abriendo chat Fuego Vivo");
  
  const chat = localizarChatFuegoVivo();
  if (!chat) {
    log("CHAT", "ERROR: No se encontró chat");
    return false;
  }
  
  chat.click();
  await new Promise(resolve => setTimeout(resolve, 1500)); // Esperar carga
  
  log("CHAT", "Chat abierto");
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. COMPOSER LEXICAL - IDENTIFICACIÓN Y ACCESO
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Localiza el composer Lexical del chat activo
 * Selectores específicos: contenteditable + role=textbox + data-lexical-editor
 */
function localizarComposerLexical() {
  log("COMPOSER", "Buscando composer Lexical");
  
  // Selector específico para Lexical editor
  const composer = document.querySelector(
    'div[contenteditable="true"][role="textbox"][data-lexical-editor="true"]'
  );
  
  if (!composer) {
    log("COMPOSER", "ERROR: Composer Lexical no encontrado");
    return null;
  }
  
  // Validación: No debe estar en el buscador
  if (composer.closest('[role="search"], [data-testid*="search"]')) {
    log("COMPOSER", "ERROR: Composer está en buscador, no en chat");
    return null;
  }
  
  // Validación: Debe estar en área de conversación
  const conversacion = composer.closest('[role="main"]') || 
                       composer.closest('[data-testid*="conversation"]');
  
  if (!conversacion) {
    log("COMPOSER", "WARNING: Composer no está en área de conversación");
    // Aún así lo retornamos, podría funcionar
  }
  
  log("COMPOSER", "Composer Lexical localizado");
  return composer;
}

/**
 * Enfoca el composer y lo prepara para escritura
 */
async function enfocarComposer(composer) {
  log("COMPOSER", "Enfocando composer");
  
  composer.focus();
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // Limpiar contenido previo
  composer.innerHTML = "";
  
  log("COMPOSER", "Composer listo");
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. ENVÍO A MESSENGER CON CONFIRMACIÓN REAL
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Formatea un lote de posts como JSON string
 */
function formatearLoteJSON(lote) {
  const jsonLines = lote.map(post => JSON.stringify(post)).join('\n');
  return jsonLines;
}

/**
 * Envía lote a Messenger con confirmación real
 * Arquitectura: Escribir → Eventos → Enviar → Verificar en chat
 */
async function enviarAMessengerConConfirmacion(lote) {
  log("SEND", "Iniciando envío a Messenger", { posts: lote.length });
  
  state.estado = "COPIANDO";
  actualizarPanel();
  
  const composer = localizarComposerLexical();
  if (!composer) {
    log("SEND", "ERROR: Composer no disponible");
    return false;
  }
  
  const jsonTexto = formatearLoteJSON(lote);
  
  try {
    // 1. Enfocar composer
    await enfocarComposer(composer);
    
    // 2. Insertar texto
    // Para Lexical, intentar múltiples métodos
    
    // Método 1: Asignación directa (menos confiable pero simple)
    composer.textContent = jsonTexto;
    
    // Método 2: Simulación de clipboard paste
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(
      new File([jsonTexto], "paste.txt", { type: "text/plain" })
    );
    
    const pasteEvent = new ClipboardEvent("paste", {
      clipboardData: dataTransfer,
      bubbles: true,
      cancelable: true
    });
    composer.dispatchEvent(pasteEvent);
    
    // 3. Disparar eventos de input para que Lexical registre
    await new Promise(resolve => setTimeout(resolve, 300));
    
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    composer.dispatchEvent(new Event("change", { bubbles: true }));
    composer.dispatchEvent(new Event("beforeinput", { bubbles: true }));
    
    await new Promise(resolve => setTimeout(resolve, 300));
    
    log("SEND", "Texto insertado, preparando envío");
    
    // 4. Enviar con Enter
    const enterKeyDown = new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true
    });
    
    const enterKeyUp = new KeyboardEvent("keyup", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true
    });
    
    composer.dispatchEvent(enterKeyDown);
    await new Promise(resolve => setTimeout(resolve, 100));
    composer.dispatchEvent(enterKeyUp);
    
    log("SEND", "Evento Enter disparado");
    
    // 5. Esperar a que Messenger procese
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    // 6. VERIFICACIÓN: Buscar el mensaje en el chat
    const mensajeAparece = await verificarMensajeEnChat(jsonTexto);
    
    if (mensajeAparece) {
      log("SEND", "✓ Mensaje confirmado en chat");
      state.stats.postsCopiados += lote.length;
      
      // Registrar posts enviados para evitar duplicación
      for (const post of lote) {
        state.postsEnviadosEnMensaje.add(post.post_id || post.url);
      }
      
      state.loteConfirmado = true;
      return true;
    } else {
      log("SEND", "ERROR: Mensaje no aparece en chat (reintentando)");
      return false;
    }
    
  } catch (error) {
    log("SEND", "ERROR durante envío", error);
    return false;
  }
}

/**
 * Verifica que el mensaje aparezca en el área de chat
 */
async function verificarMensajeEnChat(jsonBuscado) {
  log("VERIFY", "Verificando aparición en chat");
  
  const chatArea = document.querySelector('[role="main"]');
  if (!chatArea) {
    log("VERIFY", "ERROR: Área de chat no encontrada");
    return false;
  }
  
  // Buscar en los últimos mensajes (últimos 5)
  const mensajes = chatArea.querySelectorAll('[data-testid*="message"], [role="article"]');
  
  const ultimosMensajes = Array.from(mensajes).slice(-5);
  
  for (const msg of ultimosMensajes) {
    if (msg.textContent.includes(jsonBuscado)) {
      log("VERIFY", "Mensaje encontrado en chat");
      return true;
    }
  }
  
  log("VERIFY", "Mensaje no encontrado en chat");
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// 9. PURGA DE DOM - FUNCIÓN CRÍTICA
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Calcula el tamaño aproximado del DOM en MB
 */
function calcularTamanoDom() {
  // Método: Serializar el documento y medir tamaño
  const htmlString = document.documentElement.outerHTML;
  const bytes = new Blob([htmlString]).size;
  return (bytes / (1024 * 1024)).toFixed(2); // Convertir a MB
}

/**
 * PURGA DE DOM - Elimina publicaciones antiguas manteniendo infraestructura
 * 
 * Arquitectura:
 * - NO elimina: body, main, role=list, role=listitem, mount points
 * - SÍ elimina: article antiguos, divs de publicaciones descargadas
 * - Conservador: Marca antes de eliminar, verifica dependencias
 */
async function purgarDOM() {
  log("PURGE", "Iniciando purga de DOM");
  
  state.estado = "PURGANDO";
  actualizarPanel();
  
  const domAntesKB = (new Blob([document.documentElement.outerHTML]).size) / 1024;
  
  // 1. Identificar elementos seguros para eliminar
  const articulos = document.querySelectorAll('article');
  const postsDivs = document.querySelectorAll('div[id^="js_"], div[data-pagelet^="FeedItem"]');
  
  let elementosEliminados = 0;
  let tamanioEliminado = 0;
  
  // 2. Estrategia conservadora: Eliminar solo los primeros 20% de contenedores
  const articlesAEliminar = Math.ceil(articulos.length * 0.2);
  
  for (let i = 0; i < Math.min(articlesAEliminar, articulos.length); i++) {
    const art = articulos[i];
    
    // Validación: No eliminar si es crítico
    if (art.closest('nav, header, [role="banner"], [role="navigation"]')) {
      continue;
    }
    
    // Validación: No eliminar si es parte de lista importante
    if (art.closest('[role="list"]') && art.closest('[role="list"]').children.length <= 3) {
      continue;
    }
    
    try {
      // Medir tamaño antes de eliminar
      const tamanioDivHTML = art.outerHTML.length;
      
      // Eliminar
      art.remove();
      
      elementosEliminados++;
      tamanioEliminado += tamanioDivHTML;
      
      log("PURGE", `Artículo eliminado: ${tamanioDivHTML} bytes`);
      
    } catch (error) {
      log("PURGE", "ERROR eliminando artículo", error);
      continue;
    }
  }
  
  // 3. Eliminar divs de posts descargados fuera de viewport
  const postsDivAEliminar = postsDivs.length > 50 ? 
    Array.from(postsDivs).slice(0, 30) : [];
  
  for (const div of postsDivAEliminar) {
    // Verificar que no esté visible (fuera de viewport)
    const rect = div.getBoundingClientRect();
    if (rect.top > -100 && rect.top < window.innerHeight + 100) {
      continue; // Está visible, no eliminar
    }
    
    try {
      const tamanioDiv = div.outerHTML.length;
      div.remove();
      elementosEliminados++;
      tamanioEliminado += tamanioDiv;
    } catch (error) {
      log("PURGE", "ERROR eliminando div");
      continue;
    }
  }
  
  const domDespuesKB = (new Blob([document.documentElement.outerHTML]).size) / 1024;
  const domLiberadoMB = ((domAntesKB - domDespuesKB) / 1024).toFixed(2);
  
  state.stats.postsPurgados += elementosEliminados;
  state.stats.domPurgadoMB = parseFloat(domLiberadoMB);
  state.stats.domActualMB = (domDespuesKB / 1024).toFixed(2);
  
  log("PURGE", `Purga completada`, {
    elementosEliminados,
    tamanioLiberadoMB: domLiberadoMB,
    domActualMB: state.stats.domActualMB,
    domPurgadoTotalMB: state.stats.domPurgadoMB
  });
  
  actualizarPanel();
}

// ═══════════════════════════════════════════════════════════════════════════
// 10. SCROLL Y ESCANEO CONTINUO
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Realiza scroll automático
 */
async function realizarScroll() {
  state.estado = "SCROLL";
  actualizarPanel();
  
  log("SCROLL", "Realizando scroll");
  
  window.scrollBy(0, 500);
  
  await new Promise(resolve => setTimeout(resolve, 3000)); // Esperar carga
  
  state.estado = "ESPERANDO";
  actualizarPanel();
}

/**
 * Loop principal de escaneo y procesamiento
 */
async function loopPrincipal() {
  while (state.activo && !state.detenido) {
    try {
      // 1. Escanear nuevos posts
      state.estado = "ESCANEANDO";
      actualizarPanel();
      
      const nuevos = escanearPublicaciones();
      
      // 2. Procesar objetivo si existe
      if (state.objetivoId) {
        const resultado = procesarObjetivo();
        
        if (resultado.accion === "FIN_OBJETIVO" && resultado.lote) {
          const loteDedup = deduplicarLote(resultado.lote);
          const exito = await enviarAMessengerConConfirmacion(loteDedup);
          
          if (exito) {
            state.estado = "FIN OBJETIVO";
            actualizarPanel();
            break; // Detener extracción
          }
        } else if (resultado.accion === "ESPERAR" || resultado.accion === "ESPERAR_POSTERIORES") {
          // Continuar escaneando
        }
      }
      
      // 3. Procesar lotes normales (30 posts)
      if (!state.objetivoId || !state.objetivoEncontrado) {
        if (state.buffer.length >= 30) {
          const lote = obtenerLote(30);
          if (lote) {
            const loteDedup = deduplicarLote(lote);
            await enviarAMessengerConConfirmacion(loteDedup);
            await purgarDOM();
          }
        }
      }
      
      // 4. Continuar con scroll
      await realizarScroll();
      
      // Pausa pequeña antes de siguiente iteración
      await new Promise(resolve => setTimeout(resolve, 1000));
      
    } catch (error) {
      log("LOOP", "ERROR en loop principal", error);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  
  if (!state.detenido) {
    state.estado = "FIN CONTENIDO";
  } else {
    state.estado = "DETENIDO";
  }
  
  actualizarPanel();
}

// ═══════════════════════════════════════════════════════════════════════════
// 11. PANEL DE CONTROL - INTERFAZ
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Crea el panel flotante de control
 */
function crearPanel() {
  log("PANEL", "Creando panel de control");
  
  const panel = document.createElement('div');
  panel.id = 'fb-extractor-panel';
  panel.innerHTML = `
    <div class="extractor-panel-header">
      FACEBOOK SAVED — EXTRACTOR
    </div>
    
    <div class="extractor-panel-estado">
      <div class="estado-label">ESTADO</div>
      <div class="estado-valor" id="estado-valor">DETENIDO</div>
    </div>
    
    <div class="extractor-panel-stats">
      <div class="stat-row">
        <span class="stat-label">Post Cargados:</span>
        <span class="stat-value" id="stats-cargados">0</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Post Nuevos:</span>
        <span class="stat-value" id="stats-nuevos">0</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Post Copiados:</span>
        <span class="stat-value" id="stats-copiados">0</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Post Purgados:</span>
        <span class="stat-value" id="stats-purgados">0</span>
      </div>
      
      <div class="stat-separator"></div>
      
      <div class="stat-row">
        <span class="stat-label">Tamaño DOM actual:</span>
        <span class="stat-value" id="stats-dom-actual">0.00 MB</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Tamaño DOM acumulado:</span>
        <span class="stat-value" id="stats-dom-acumulado">0.00 MB</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Tamaño DOM purgado:</span>
        <span class="stat-value" id="stats-dom-purgado">0.00 MB</span>
      </div>
    </div>
    
    <div class="extractor-panel-objetivo">
      <div class="objetivo-label">POST OBJETIVO</div>
      <input 
        type="text" 
        id="input-objetivo" 
        placeholder="ID publicación (opcional)"
        class="objetivo-input"
      />
      <div class="objetivo-help">Al detectarlo se procesan 3 posts posteriores y se detiene</div>
    </div>
    
    <div class="extractor-panel-controls">
      <button id="btn-iniciar" class="control-btn btn-iniciar">▶ Iniciar</button>
      <button id="btn-detener" class="control-btn btn-detener">■ Detener</button>
      <button id="btn-purgar" class="control-btn btn-purgar">⌫ Purgar</button>
      <button id="btn-guardar-dom" class="control-btn btn-guardar">✄ Guardar DOM</button>
    </div>
  `;
  
  document.body.appendChild(panel);
  
  // Event listeners
  document.getElementById('btn-iniciar').addEventListener('click', iniciar);
  document.getElementById('btn-detener').addEventListener('click', detener);
  document.getElementById('btn-purgar').addEventListener('click', purgarDOM);
  document.getElementById('btn-guardar-dom').addEventListener('click', guardarDOM);
  
  document.getElementById('input-objetivo').addEventListener('change', (e) => {
    state.objetivoId = e.target.value.trim() || null;
    log("OBJECTIVE", `Objetivo configurado: ${state.objetivoId || "ninguno"}`);
  });
  
  log("PANEL", "Panel creado exitosamente");
}

/**
 * Actualiza el panel con estadísticas actuales
 */
function actualizarPanel() {
  if (!document.getElementById('fb-extractor-panel')) return;
  
  document.getElementById('estado-valor').textContent = state.estado;
  document.getElementById('stats-cargados').textContent = state.stats.postsCargados;
  document.getElementById('stats-nuevos').textContent = state.stats.postsNuevos;
  document.getElementById('stats-copiados').textContent = state.stats.postsCopiados;
  document.getElementById('stats-purgados').textContent = state.stats.postsPurgados;
  
  state.stats.domActualMB = calcularTamanoDom();
  state.stats.domAcumuladoMB = Math.max(
    parseFloat(state.stats.domAcumuladoMB || 0),
    parseFloat(state.stats.domActualMB)
  );
  
  document.getElementById('stats-dom-actual').textContent = `${state.stats.domActualMB} MB`;
  document.getElementById('stats-dom-acumulado').textContent = `${state.stats.domAcumuladoMB} MB`;
  document.getElementById('stats-dom-purgado').textContent = `${state.stats.domPurgadoMB} MB`;
}

/**
 * Guarda el DOM actual para depuración
 */
async function guardarDOM() {
  log("DEBUG", "Guardando DOM para depuración");
  
  const html = document.documentElement.outerHTML;
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `facebook-saved-dom-${new Date().toISOString()}.html`;
  a.click();
  URL.revokeObjectURL(url);
  
  log("DEBUG", "DOM guardado");
}

// ═══════════════════════════════════════════════════════════════════════════
// 12. CONTROL PRINCIPAL - INICIAR / DETENER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Inicia la extracción
 */
async function iniciar() {
  log("INIT", "Iniciando extracción");
  
  if (state.activo) {
    log("INIT", "Extracción ya está activa");
    return;
  }
  
  state.activo = true;
  state.detenido = false;
  state.estado = "INICIANDO";
  actualizarPanel();
  
  try {
    // 1. Abrir Messenger
    log("INIT", "Abriendo Messenger");
    const messengerAbierto = await abrirMessenger();
    if (!messengerAbierto) {
      throw new Error("No se pudo abrir Messenger");
    }
    
    // 2. Abrir chat
    log("INIT", "Abriendo chat Fuego Vivo");
    const chatAbierto = await abrirChatFuegoVivo();
    if (!chatAbierto) {
      throw new Error("No se pudo abrir chat Fuego Vivo");
    }
    
    // 3. Escaneo inicial
    state.estado = "ESCANEO INICIAL";
    actualizarPanel();
    
    const iniciales = escanearPublicaciones();
    log("INIT", `Posts iniciales detectados: ${iniciales}`);
    
    // 4. Iniciar loop principal
    log("INIT", "Iniciando loop de procesamiento");
    await loopPrincipal();
    
  } catch (error) {
    log("INIT", "ERROR durante inicialización", error);
    state.estado = "ERROR";
    actualizarPanel();
  } finally {
    state.activo = false;
  }
}

/**
 * Detiene la extracción
 */
function detener() {
  log("STOP", "Deteniendo extracción");
  
  state.detenido = true;
  state.activo = false;
  state.estado = "DETENIDO";
  
  // Limpiar timers
  if (state.scrollTimer) clearTimeout(state.scrollTimer);
  if (state.scanTimer) clearTimeout(state.scanTimer);
  if (state.waitTimer) clearTimeout(state.waitTimer);
  
  actualizarPanel();
  log("STOP", "Extracción detenida");
}

// ═══════════════════════════════════════════════════════════════════════════
// 13. INICIALIZACIÓN DE LA EXTENSIÓN
// ═══════════════════════════════════════════════════════════════════════════

function inicializarExtension() {
  log("STARTUP", "Inicializando extensión Facebook Saved Extractor V2.0.0");
  
  // Esperar a que DOM esté listo
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', crearPanel);
  } else {
    crearPanel();
  }
  
  log("STARTUP", "Extensión lista");
}

// Iniciar cuando el script cargue
inicializarExtension();

// ═══════════════════════════════════════════════════════════════════════════
// FIN DEL CONTENIDO
// ═══════════════════════════════════════════════════════════════════════════
