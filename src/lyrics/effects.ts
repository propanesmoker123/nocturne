import type { Lyrics, LyricsLine } from '../vk/models'

export const WORD_EFFECTS = [
  'flash',
  'glow',
  'metal',
  'neon',
  'rush',
  'ripple',
  'big',
  'fire',
  'ice',
  'rain',
  'heart',
  'shake',
  'glitch',
  'cash',
  'smoke',
  'slash',
  'orbit',
  'bounce',
  'fade',
  'poison',
] as const

export type WordFx = (typeof WORD_EFFECTS)[number]
export type FxVariant = 0 | 1 | 2 | 3

export interface AnalyzedLine {
  textFx?: WordFx
  wordFx: Map<number, WordFx>
  wordVariant: Map<number, FxVariant>
  wordEmoji: Map<number, string>
}

export interface LyricsAnalysis {
  lineFx: Map<number, AnalyzedLine>
}

export interface LyricsMethodInfo {
  sourceLabel: string
  syncLabel: string
  fxLabel: string
}

const WORD_RULES: readonly [WordFx, RegExp][] = [
  [
    'glitch',
    /glitch|glitches|error|static|noise|matrix|phantom|corrupt|distort|hallucinat|\bfake\b|\bbug\b|\bhack(?:er|ed|ing)?\b|pixel|reboot|simulac|mirage|screen|\bsignal\b|\bphone\b|\bcall\b|\bbroken\b|\bsystem\b|\u0433\u043b\u044e\u043a|\u0433\u043b\u0438\u0442\u0447|\u0441\u0431\u043e\u0439|\u043c\u0430\u0442\u0440\u0438\u0446|\u0432\u0438\u0440\u0443\u0441|\u043f\u043e\u043c\u0435\u0445|\u0444\u0435\u0439\u043a|\u0444\u0430\u043d\u0442\u043e\u043c|\u044d\u043a\u0440\u0430\u043d|\u0441\u0438\u0433\u043d\u0430\u043b|\u0442\u0440\u0435\u0449\u0438\u043d|\u0441\u043b\u043e\u043c\u0430\u043d|\u0430\u043d\u043e\u043c\u0430\u043b|\u043f\u0438\u043a\u0441\u0435\u043b|^\u0431\u0430\u0433(?:\u0438|\u043e\u0432|\u0430)?$|^\u043a\u043e\u0434(?:\u0435|\u0430|\u044b)?$|\u0445\u0430\u043a\u0435\u0440|\u043c\u0438\u0440\u0430\u0436|\u0438\u043b\u043b\u044e\u0437|\u0441\u0438\u043c\u0443\u043b\u044f|\u0442\u0435\u043b\u0435\u0444\u043e\u043d|\u0437\u0432\u043e\u043d[\u0438\u043e\u043a\u044f]|^\u0441\u0435\u0442[\u044c\u0438]$|\u043e\u043d\u043b\u0430\u0439\u043d|\u043e\u0448\u0438\u0431\u043a|\u0441\u0438\u0441\u0442\u0435\u043c|codigo|fallo|erreur|fehler/,
  ],
  [
    'poison',
    /poison|toxic|venom|addict|potion|drunk|wasted|hangover|curse|\bdrug|\bacid|\bsin(?:s|ner)?\b|tequila|whiskey|vodka|champagne|\bwine\b|\bsnake|\bbite\b|\bbitter\b|\bthirst\b|^\u044f\u0434(?:\u0430|\u0443|\u043e\u043c|\u0435|\u043e\u0432)?$|^\u044f\u0434\u043e\u0432\u0438\u0442|\u043e\u0442\u0440\u0430\u0432|\u0442\u043e\u043a\u0441\u0438\u043a|\u0442\u043e\u043a\u0441\u0438\u0447|\u0437\u0430\u0432\u0438\u0441\u0438\u043c|\u043d\u0430\u0440\u043a\u043e|\u043a\u0430\u0439\u0444|\u0434\u043e\u0437\u0430|\u0442\u0430\u0431\u043b\u0435\u0442|\u0437\u0435\u043b\u044c|\u0434\u0443\u0440\u043c\u0430\u043d|\u043f\u044c\u044f\u043d|\u0445\u043c\u0435\u043b|\u043f\u043e\u0445\u043c\u0435\u043b|\u043f\u0440\u043e\u043a\u043b\u044f\u0442|\u0432\u044b\u043f\u0438|^\u0432\u0438\u043d[\u043e\u0430\u0443]$|\u0432\u0438\u0441\u043a\u0438|\u0442\u0435\u043a\u0438\u043b|\u0432\u043e\u0434\u043a|\u0448\u0430\u043c\u043f\u0430\u043d|\u0433\u0440\u0435\u0445|\u0432\u0435\u043d\u043e\u043c|\u0437\u043c\u0435[\u044f\u0438\u044e]|\u0433\u043e\u0440\u044c\u043a|\u0436\u0430\u0436\u0434|\u043f\u043e\u0440\u043e\u043a|^\u043f\u0435\u0439$|veneno|toxico|pecado|toxique|ivre|\bgift(?:ig)?\b/,
  ],
  [
    'slash',
    /slash|slice|knife|\bscar(?:s)?\b|blood|bleed|sharp|wound|stab|razor|katana|dagger|\bsword\b|claw|\blies\b|\blie\b|\bwar\b|\bfight\b|betray|^\u043d\u043e\u0436(?:\u0438|\u0430|\u0443|\u043e\u043c|\u0435\u0439)?$|\u043f\u043e\u0440\u0435\u0437|\u0440\u0435\u0436\u0435\u0442|\u0440\u0435\u0436\u044c|\u0448\u0440\u0430\u043c|\u043a\u0440\u043e\u0432|\u0431\u0440\u0438\u0442\u0432|\u0440\u0430\u043d[\u0430\u0435\u0443\u044b]|\u043e\u0441\u0442\u0440|\u0432\u0434\u0440\u0435\u0431\u0435\u0437\u0433|\u0440\u0430\u0441\u0441\u0435\u043a|\u0440\u0432\u0430\u043d|\u0443\u0434\u0430\u0440|\u0441\u043c\u0435\u0440\u0442|\u0443\u043c\u0438\u0440|\u0443\u0431\u0438\u0442|\u043a\u0430\u0442\u0430\u043d|\u043a\u0438\u043d\u0436\u0430\u043b|\u043f\u0440\u0435\u0434\u0430|\u0432\u0440\u0430\u0433|^\u043b\u043e\u0436\u044c$|^\u0432\u0440\u0443$|^\u0432\u0440\u0435\u0448\u044c|\u0432\u043e\u0439\u043d|^\u0431\u043e[\u0439\u044e]$|sangre|cuchillo|herida|\bsang\b|couteau|\bblut\b|messer/,
  ],
  [
    'cash',
    /\bcash\b|\bmoney\b|\bbucks?\b|\brich\b|dollar|euro|\bcoin(?:s)?\b|flex|luxury|wealth|stack|yacht|billion|million|trillion|\bbands\b|\bracks\b|\bguap\b|\bgwap\b|moolah|\bdrip\b|bling|rolex|gucci|prada|versace|balenci|cartier|bentley|lambo|ferrari|porsche|maybach|\bpaid\b|paycheck|profit|crypto|bitcoin|expensive|spend|dinero|billete|riqueza|lujo|\bargent\b|monnaie|richesse|\bgeld\b|reichtum|^\u043a[\u0435\u044d]\u0448|^\u043c\u0430\u043d\u0438$|^\u0431\u0430\u0431\u043a\u0438$|\u0431\u0430\u0431\u043a\u0430\u0445|\u0431\u0430\u0431\u043a\u0430\u043c|\u0431\u0430\u0431\u043e\u043a|\u0431\u0430\u0431\u043b|\u0434\u0435\u043d\u0435\u0433|\u0434\u0435\u043d\u0435\u0436|\u0434\u0435\u043d\u044c\u0433|^\u043b\u0430\u0432[\u0435\u044d]$|\u0433\u0443\u0430\u043f|\u0433\u0432\u0430\u043f|\u0440\u044d\u043a\u0441|\u0431\u044d\u043d\u0434\u0441|\u043c\u0438\u043b\u043b\u0438\u043e\u043d|\u043c\u0438\u043b\u043b\u0438\u0430\u0440\u0434|^\u043b\u044f\u043c(?:\u0430|\u043e\u0432|\u044b)?$|\u0431\u0430\u043a\u0441|\u0434\u043e\u043b\u043b\u0430\u0440|\u0435\u0432\u0440\u043e|\u0440\u0443\u0431\u043b|\u0433\u0440\u0438\u0432\u043d|\u0442\u0435\u043d\u0433\u0435|\u0433\u0440\u043e\u0448|\u043c\u043e\u043d\u0435\u0442|\u043a\u0443\u043f\u044e\u0440|\u0431\u0430\u043d\u043a\u043d\u043e\u0442|^\u043d\u0430\u043b(?:\u0430|\u043e\u043c|\u0435)?$|\u043d\u0430\u043b\u0438\u043a|\u043d\u0430\u043b\u0438\u0447|\u043a\u0430\u043f\u0443\u0441\u0442|^\u0437\u0435\u043b\u0435\u043d(?:\u044c|\u0438|\u044e)?$|\u043b\u044e\u043a\u0441|\u043b\u0430\u043a\u0448\u0435\u0440|\u0431\u0440\u0435\u043d\u0434|\u0433\u0443\u0447\u0447\u0438|\u043f\u0440\u0430\u0434\u0430|\u043a\u0430\u0440\u0442\u044c\u0435|\u0431\u0435\u043d\u0442\u043b|\u043c\u0430\u0439\u0431\u0430\u0445|\u043b\u0430\u043c\u0431\u043e|\u0444\u0435\u0440\u0440\u0430\u0440\u0438|\u043f\u043e\u0440\u0448|\u0433\u0435\u043b\u0438\u043a|\u044f\u0445\u0442|\u043c\u0430\u0436\u043e\u0440|\u0431\u043e\u0433\u0430\u0442|\u043a\u0430\u0440\u0430\u0442|\u0440\u043e\u043b\u0435\u043a\u0441|\u0446\u0435\u043d\u043d\u0438\u043a|\u043f\u0440\u0430\u0439\u0441|\u043f\u0440\u0438\u0431\u044b\u043b|\u043f\u0435\u043d\u0442\u0445\u0430\u0443\u0441|\u0431\u0443\u043c\u0430\u0436\u043a|^\u0447\u0435\u043a(?:\u0438|\u0430|\u043e\u0432)?$|\u043a\u0440\u0438\u043f\u0442|\u0431\u0438\u0442\u043a\u043e\u0438\u043d|\u0444\u043e\u0440\u0431\u0441|\u0434\u043e\u0440\u043e\u0433(?:\u043e|\u0430\u044f|\u0438\u0435)|\u0442\u0440\u0430\u0447\u0443|\u043a\u0443\u043f\u0438\u043b|\u0441\u043a\u0443\u043f\u0430/,
  ],
  [
    'smoke',
    /smoke|smoking|\bfog\b|foggy|\bmist\b|misty|haze|cloud|vapor|puff|exhale|inhale|breathe|breath|\bdust\b|fume|smog|cigarette|cigar|vape|\bwind\b|\bair\b|humo|niebla|nube|fumee|brouillard|nuage|rauch|nebel|wolke|\u0434\u044b\u043c|\u0442\u0443\u043c\u0430\u043d|\u043e\u0431\u043b\u0430\u043a|\u0441\u0438\u0433\u0430\u0440\u0435\u0442|\u043f\u0435\u043b\u0435\u043d|\u0432\u044b\u0434\u043e\u0445|\u0432\u0434\u043e\u0445|\u0434\u044b\u0448|\u0432\u043e\u0437\u0434\u0443\u0445|\u0432\u0435\u0442\u0435\u0440|\u0432\u0435\u0442\u0440|\u043a\u0430\u043b\u044c\u044f\u043d|\u0441\u043c\u043e\u0433|\u043f\u0430\u0440\u0438\u0442|\u0443\u0433\u0430\u0440|\u0432\u0435\u0439\u043f|\u0442\u0430\u0431\u0430\u043a|\u043c\u0433\u043b\u0430|\u043f\u044b\u043b\u044c/,
  ],
  [
    'orbit',
    /space|orbit|planet|galax|univers|spin|float|dizzy|gravit|cosmic|cosmos|satellit|comet|meteor|nebula|saturn|mars|levitat|weightless|\baround\b|\bsky\b|espacio|planeta|espace|weltall|\u043a\u043e\u0441\u043c\u043e\u0441|\u043a\u043e\u0441\u043c\u0438\u0447|\u043e\u0440\u0431\u0438\u0442|\u043f\u043b\u0430\u043d\u0435\u0442|\u0432\u0441\u0435\u043b\u0435\u043d\u043d|\u043d\u0435\u0432\u0435\u0441\u043e\u043c|\u0433\u0430\u043b\u0430\u043a\u0442\u0438\u043a|\u043a\u0440\u0443\u0436|\u0432\u043e\u043a\u0440\u0443\u0433|\u0433\u0440\u0430\u0432\u0438\u0442\u0430\u0446|\u0441\u043f\u0443\u0442\u043d\u0438\u043a|\u043a\u043e\u043c\u0435\u0442|\u043c\u0435\u0442\u0435\u043e\u0440|\u0441\u0430\u0442\u0443\u0440\u043d|\u043b\u0435\u0432\u0438\u0442\u0430\u0446|\u0431\u0435\u0441\u043a\u043e\u043d\u0435\u0447/,
  ],
  [
    'bounce',
    /jump|bounce|\bbass\b|vibe|groove|drop|party|\bhop\b|dance|phonk|\btrap\b|boogie|\bflow\b|\bsong\b|\btrack\b|\bmusic\b|\bsound\b|\bstyle\b|\bmove\b|bailar|baile|danser|tanzen|\u043f\u0440\u044b\u0433|\u043a\u0430\u0447\u0430|^\u043a\u0430\u0447$|^\u0431\u0438\u0442(?:$|\u043e\u043c|\u044b|\u0430|\u0435)|\u0431\u0430\u0441\u0441|\u0444\u043b\u0435\u043a\u0441|\u0441\u043a\u0430\u0447|\u0432\u0430\u0439\u0431|\u0442\u0430\u043d\u0446|\u0442\u0443\u0441\u0430|\u0442\u0443\u0441\u043e\u0432|\u043e\u0442\u0440\u044b\u0432|\u0440\u0430\u0441\u043a\u0430\u0447|\u0444\u043e\u043d\u043a|\u0442\u0440\u044d\u043f|\u0434\u044d\u043d\u0441|\u0442\u0440\u0435\u043a|\u043f\u0435\u0441\u043d|\u043c\u0443\u0437\u044b\u043a|\u0444\u043b\u043e\u0443|\u0441\u0442\u0438\u043b\u044c|\u0437\u0432\u0443\u043a/,
  ],
  [
    'fade',
    /fade|gone|empty|alone|lonely|solitud|memory|forget|goodbye|farewell|silent|silence|quiet|vanish|lost|void|ghost|shadow|dream|sleep|\bnever\b|\bnobody\b|\bnothing\b|\bend\b|\btired\b|\bleave\b|apart|\bmind\b|vacio|\bsolo\b|sombra|vide|\bseul\b|ombre|leer|allein|schatten|stille|\u0438\u0441\u0447\u0435\u0437|^\u043f\u0443\u0441\u0442(?:\u0430|\u043e|\u044b|\u0438|\u0435)|\u043e\u0434\u0438\u043d\u043e\u043a|\u0442\u0438\u0445[\u043e\u0438]|\u0442\u0438\u0448\u0438\u043d|\u043c\u043e\u043b\u0447|\u043f\u0430\u043c\u044f\u0442|\u043f\u043e\u043c\u043d|\u0437\u0430\u0431\u044b\u0442|\u0437\u0430\u0431\u0443\u0434|\u043f\u0440\u043e\u0448\u043b|\u0443\u0448\u0435\u043b|\u0443\u0448\u043b\u0430|\u0443\u0448\u043b\u0438|\u043f\u0440\u043e\u0449\u0430|\u0442\u0435\u0440\u044f|\u043f\u0440\u0438\u0437\u0440\u0430\u043a|\u0442\u0435\u043d[\u044c\u0438]|\u043d\u0438\u043a\u0443\u0434\u0430|\u043d\u0438\u043a\u043e\u0433\u0434\u0430|\u043d\u0438\u043a\u0442\u043e|\u0442\u044c\u043c[\u0430\u0443\u044b\u0435]|\u0442\u0435\u043c\u043d[\u043e\u0430\u044b]|\u043c\u0440\u0430\u043a|^\u0441\u043e\u043d$|^\u0441\u043d\u044b$|\u0441\u043d\u0430\u0445|\u0440\u0430\u0441\u0442\u0432\u043e\u0440|\u043f\u0435\u0447\u0430\u043b|\u0433\u0440\u0443\u0441\u0442|\u0443\u0441\u0442\u0430\u043b|\u043c\u044b\u0441\u043b[\u044c\u0438\u0435]|\u0432\u0447\u0435\u0440\u0430|\u043d\u0430\u0437\u0430\u0434|\u043a\u043e\u043d\u0435\u0446|\u0444\u0438\u043d\u0430\u043b/,
  ],
  [
    'ice',
    /\bice\b|icy|cold|freez|frozen|frost|snow|winter|crystal|shiver|chill|blizzard|glacier|arctic|subzero|\bnumb\b|hielo|frio|nieve|invierno|glace|froid|neige|hiver|\beis\b|\bkalt\b|schnee|\u043b\u0435\u0434|\u043b\u044c\u0434|\u0445\u043e\u043b\u043e\u0434|\u0437\u0438\u043c[\u0430\u0435\u0443\u044b]|\u0441\u043d\u0435\u0433|\u0441\u043d\u0435\u0436|\u043c\u043e\u0440\u043e\u0437|\u0437\u0430\u043c\u0435\u0440\u0437|\u043a\u0440\u0438\u0441\u0442\u0430\u043b\u043b|\u0441\u0442\u0443\u0436|\u0438\u043d\u0435\u0439|\u043c\u0435\u0440\u0437\u043d|\u043c\u0435\u0442\u0435\u043b|\u0432\u044c\u044e\u0433|\u0430\u0439\u0441|\u043e\u0441\u0442\u044b\u043b|\u043f\u0440\u043e\u0445\u043b\u0430\u0434/,
  ],
  [
    'rain',
    /rain|tear|cry|crying|wept|water|ocean|\bsea\b|drown|storm|flood|drop|wet|river|puddle|monsoon|tsunami|\bdeep\b|\bsink\b|\bwash\b|lluvia|lagrima|llorar|agua|tormenta|pluie|larme|pleurer|\beau\b|orage|regen|trane|weinen|wasser|meer|\u0434\u043e\u0436\u0434|\u0441\u043b\u0435\u0437|\u043f\u043b\u0430\u0447|\u0440\u044b\u0434\u0430|^\u0432\u043e\u0434[\u0430\u0443\u044b\u0435]$|^\u043c\u043e\u0440[\u0435\u044f]$|\u043e\u043a\u0435\u0430\u043d|\u0442\u043e\u043d\u0443|\u043a\u0430\u043f\u043b|\u043b\u0438\u0432\u0435\u043d|\u043b\u0438\u0432\u043d|^\u0433\u0440\u043e\u0437(?:\u0430|\u044b|\u0443|\u043e\u0439|\u0435)?$|\u0442\u0443\u0447[\u0430\u0438]|\u043b\u0443\u0436|\u043f\u0440\u043e\u043c\u043e\u043a|\u0448\u0442\u043e\u0440\u043c|^\u0440\u0435\u043a[\u0430\u0438\u0443\u0435]$|\u0433\u043b\u0443\u0431[\u0438\u043e]/,
  ],
  [
    'neon',
    /neon|night|midnight|tonight|cyber|laser|disco|rave|electro|retro|synth|club|city|street|skyline|highway|headlight|noche|ciudad|calle|nuit|ville|nacht|stadt|\u043d\u0435\u043e\u043d|\u043e\u0433\u043d\u0438|\u043e\u0433\u043d\u044f\u0445|\u043e\u0433\u043d\u0435\u0439|\u043d\u043e\u0447[\u044c\u0438\u044e]|\u043f\u043e\u043b\u043d\u043e\u0447|\u043a\u0438\u0431\u0435\u0440|\u043b\u0430\u0437\u0435\u0440|\u0440\u0435\u0439\u0432|\u043a\u043b\u0443\u0431|\u0433\u043e\u0440\u043e\u0434|\u0442\u0440\u0430\u0441\u0441|\u0444\u043e\u043d\u0430\u0440|\u043f\u0440\u043e\u0441\u043f\u0435\u043a\u0442|\u0441\u0438\u043d\u0442\u0435\u0437|\u043c\u0435\u0433\u0430\u043f\u043e\u043b\u0438\u0441|\u0443\u043b\u0438\u0446|\u043a\u0432\u0430\u0440\u0442\u0430\u043b|\u044d\u0442\u0430\u0436|\u043e\u043a\u043d[\u043e\u0430]|\u0444\u0430\u0440[\u044b\u0430]/,
  ],
  [
    'fire',
    /fire|burn|flame|blaze|inferno|heat|\bhell\b|\bhot\b|ember|ash|ashes|demon|devil|lava|volcan|warm|ignite|fuego|llama|infierno|flamme|\bfeu\b|enfer|feuer|brenn|heiss|\u043e\u0433\u043e\u043d\u044c|\u043e\u0433\u043d[\u044f\u0435]|\u043e\u0433\u043d\u0435\u043d|\u0433\u043e\u0440[\u0438\u044f\u044e]|\u043f\u043e\u0436\u0430\u0440|\u043f\u043b\u0430\u043c|^\u0436\u0430\u0440(?:\u0430|\u0438|\u0443|\u043e\u043c|\u0435|\u043a)?|\u0436\u0436\u0435\u0442|\u0441\u0433\u043e\u0440|^\u0430\u0434(?:\u0430|\u0443|\u043e\u043c|\u0435)?$|^\u0430\u0434\u0441\u043a|\u0434\u044c\u044f\u0432\u043e\u043b|\u0434\u0435\u043c\u043e\u043d|\u043a\u043e\u0441\u0442\u0435\u0440|\u043f\u044b\u043b\u0430|\u043f\u0435\u043f\u0435\u043b|\u043f\u0435\u043a\u043b|\u0444\u0430\u0435\u0440|\u0442\u0435\u043f\u043b[\u043e\u0430\u044b]|^\u0433\u0440\u0435\u0439/,
  ],
  [
    'metal',
    /steel|chrome|silver|iron|chain|blade|armor|diamond|mirror|metal|titanium|platinum|cobalt|glass|stone|bullet|\bgun\b|acero|hierro|diamante|acier|\bfer\b|diamant|stahl|silber|chrom|\u043c\u0435\u0442\u0430\u043b\u043b|\u0441\u0442\u0430\u043b[\u044c\u0438]|\u0436\u0435\u043b\u0435\u0437|\u0445\u0440\u043e\u043c|\u0446\u0435\u043f[\u044c\u0438\u044f]|\u043a\u043b\u0438\u043d\u043e\u043a|\u043b\u0435\u0437\u0432\u0438|\u043f\u0443\u043b[\u044f\u0438\u044e]|\u0431\u0440\u043e\u043d[\u044f\u0438]|\u0430\u043b\u043c\u0430\u0437|\u0431\u0440\u0438\u043b\u043b\u0438\u0430\u043d\u0442|\u0437\u0435\u0440\u043a\u0430\u043b|\u0441\u0435\u0440\u0435\u0431\u0440|\u0442\u0432\u0435\u0440\u0434|\u0442\u0438\u0442\u0430\u043d|\u043f\u043b\u0430\u0442\u0438\u043d|\u0441\u0442\u0435\u043a\u043b|\u043a\u0430\u043c\u0435\u043d|\u043a\u0430\u043c\u043d|\u0441\u0442\u0435\u043d[\u0430\u044b\u0443]/,
  ],
  [
    'flash',
    /flash|blinding|blinded|spotlight|strobe|lightning|flare|spark|thunder|dazzle|explod|boom|\bbang\b|volt|\beyes?\b|\blook\b|\bwatch\b|\bsee\b|\bwhite\b|rayo|chispa|eclair|blitz|funke|\u0432\u0441\u043f\u044b\u0448|\u043e\u0441\u043b\u0435\u043f|\u043c\u043e\u043b\u043d|\u0432\u0437\u0440\u044b\u0432|\u0431\u044d\u043d\u0433|\u0438\u0441\u043a\u0440|\u0441\u0442\u0440\u043e\u0431|\u0431\u043b\u0435\u0441\u043a|\u0441\u0432\u0435\u0440\u043a|\u043e\u0437\u0430\u0440|\u0432\u044b\u0441\u0442\u0440\u0435\u043b|\u0441\u0430\u043b\u044e\u0442|\u0444\u043b\u0435\u0448|^\u0441\u0432\u0435\u0442(?:\u0430|\u0443|\u043e\u043c|\u0435)?$|\u0433\u043b\u0430\u0437|\u0441\u043c\u043e\u0442\u0440|\u0432\u0438\u0436\u0443|\u044f\u0440\u043a|\u0431\u0435\u043b[\u044b\u0430\u043e]/,
  ],
  [
    'glow',
    /glow|shine|gold|golden|\bsun\b|sunlight|sunrise|sunset|star|moon|halo|aurora|divine|heaven|angel|magic|aura|bright|radiant|\blife\b|\blive\b|\btruth\b|\breal\b|\btrue\b|\bmorning\b|\btomorrow\b|\bhope\b|\boro\b|\bsol\b|estrella|soleil|etoile|lumiere|sonne|stern|engel|\u0441\u0438\u044f|\u0437\u043e\u043b\u043e\u0442|\u043b\u0443\u043d[\u0430\u0435\u0443\u044b]|\u0441\u043e\u043b\u043d\u0446|\u0437\u0432\u0435\u0437\u0434|\u0437\u0430\u0440[\u044f\u0438]|\u0440\u0430\u0441\u0441\u0432\u0435\u0442|\u0437\u0430\u043a\u0430\u0442|^\u043c\u0430\u0433\u0438|^\u0440\u0430[\u0439\u044e\u044f\u0435]$|\u0430\u043d\u0433\u0435\u043b|\u0430\u0443\u0440\u0430|\u0431\u043b\u0435\u0441\u0442|\u043d\u0435\u0431\u0435\u0441|^\u043d\u0435\u0431[\u043e\u0430\u0443]$|\u043d\u0438\u043c\u0431|\u043c\u0435\u0447\u0442|\u043a\u0440\u0430\u0441[\u0438\u043e]|\u0441\u0447\u0430\u0441\u0442|\u0436\u0438\u0437\u043d|\u0436\u0438\u0432[\u0443\u0438\u0435]|\u0443\u0442\u0440[\u043e\u0430]|\u0437\u0430\u0432\u0442\u0440\u0430|\u043f\u0440\u0430\u0432\u0434|\u043d\u0430\u0434\u0435\u0436\u0434|\u0447\u0443\u0434[\u043e\u0435]/,
  ],
  [
    'rush',
    /rush|\brun\b|running|fast|speed|\bfly\b|flying|flight|drive|drift|escape|race|chase|runaway|sprint|turbo|nitro|wings|throttle|\broad\b|\bpath\b|\brise\b|\bhigh\b|\bfar\b|\baway\b|rapido|velocidad|voler|vitesse|fliegen|schnell|\u0431\u0435\u0433[\u0438\u0443]|\u0431\u0435\u0436|\u043b\u0435\u0442[\u0438\u0435]|\u043b\u0435\u0447\u0443|\u0433\u043e\u043d[\u0438\u044f\u043a]|\u0441\u043a\u043e\u0440\u043e\u0441\u0442|\u0431\u044b\u0441\u0442\u0440|\u0443\u043b\u0435\u0442|\u043c\u0447\u0443|\u043c\u0447\u0438\u0442|\u0434\u0440\u0438\u0444\u0442|\u0434\u0440\u0430\u0439\u0432|\u0442\u0443\u0440\u0431\u043e|\u043d\u0438\u0442\u0440\u043e|\u043f\u043e\u0431\u0435\u0433|\u043c\u043e\u0442\u043e\u0440|\u043a\u0440\u044b\u043b|\u0444\u043e\u0440\u0441\u0430\u0436|\u0432\u043f\u0435\u0440\u0435\u0434|\u0434\u043e\u0440\u043e\u0433[\u0430\u0438\u0443\u0435]|\u043f\u0443\u0442[\u044c\u0438]|\u0434\u0430\u043b\u0435\u043a|\u0432\u0432\u0435\u0440\u0445/,
  ],
  [
    'ripple',
    /\btime\b|\btick\b|\btock\b|clock|\bhour\b|\becho\b|\bwave\b|eternit|pulse|rhythm|second|minut|moment|\bagain\b|\bdaily\b|circle|tiempo|reloj|\beco\b|temps|horloge|\bonde\b|zeit|\buhr\b|welle|\u0432\u0440\u0435\u043c|^\u0442\u0438\u043a$|^\u0442\u0430\u043a$|\u0447\u0430\u0441[\u0430\u044b\u043e]?|\u043c\u0438\u0433|\u0432\u0435\u0447\u043d|\u044d\u0445\u043e|\u0432\u043e\u043b\u043d|\u043a\u0440\u0443\u0433|\u0440\u0438\u0442\u043c|\u043f\u0443\u043b\u044c\u0441|\u0441\u0435\u043a\u0443\u043d\u0434|\u043c\u0438\u043d\u0443\u0442|\u043c\u0433\u043d\u043e\u0432\u0435\u043d|\u0441\u0442\u0443\u043a|\u0441\u043d\u043e\u0432\u0430|\u043e\u043f\u044f\u0442\u044c|\u0441\u0435\u0433\u043e\u0434\u043d|^\u0434\u0435\u043d\u044c$|\u0434\u043d\u0435\u043c|\u0433\u043e\u043b\u043e\u0441/,
  ],
  [
    'heart',
    /\blove\b|lover|loving|heart|soul|kiss|\bhold\b|feel|hurt|ache|adore|darling|baby|passion|desire|sweetheart|\btouch\b|\bwant\b|\bneed\b|\bmiss\b|\bstay\b|together|\byours\b|\bmine\b|\blips\b|\bhands\b|\bamor\b|corazon|beso|alma|amour|coeur|baiser|liebe|herz|kuss|seele|\u043b\u044e\u0431[\u043b\u044e\u043e\u0432\u0438]|\u043a\u043e\u0445\u0430|\u0441\u0435\u0440\u0434[\u0446\u0435]|\u0434\u0443\u0448[\u0430\u0438\u0435\u0443]|\u043d\u0435\u0436\u043d|\u043e\u0431\u043d\u0438\u043c|\u043f\u043e\u0446\u0435\u043b\u0443|\u0440\u043e\u0434\u043d|\u0441\u043a\u0443\u0447\u0430|\u0431\u043e\u043b[\u044c\u0438]|\u0441\u0442\u0440\u0430\u0441\u0442|\u0447\u0443\u0432\u0441\u0442\u0432|\u043c\u0430\u043b\u044b\u0448|\u043a\u0440\u0430\u0448|\u043c\u0438\u043b\u0430\u044f|\u0440\u0430\u0437\u0431\u0438\u043b|\u043e\u0441\u043a\u043e\u043b\u043a|\u0433\u0443\u0431[\u044b\u0430]|\u0440\u0443\u043a[\u0438\u0430\u0443]|\u0432\u043c\u0435\u0441\u0442\u0435|\u0442\u0432\u043e[\u044f\u0438\u0435\u0439]|^\u0445\u043e\u0447\u0443$|\u043d\u0443\u0436[\u0435\u043d\u0430]|\u0442\u043e\u0441\u043a[\u0430\u0443\u0438]/,
  ],
  [
    'shake',
    /shake|break|crash|smash|rage|fury|madness|panic|trembl|\bfear\b|crazy|wild|psycho|insane|scream|chaos|miedo|loco|rabia|peur|angst|wut|\u0434\u0440\u043e\u0436|\u0431\u0435\u0441\u0438\u0442|\u0441\u0440\u044b\u0432\u0430|\u0440\u0432\u0435\u0442|\u043f\u0441\u0438\u0445|\u0441\u0442\u0440\u0430\u0445|\u0431\u043e\u044e\u0441\u044c|\u0443\u0436\u0430\u0441|\u0431\u0435\u0437\u0443\u043c|\u0442\u0440\u044f\u0441|\u0433\u0440\u043e\u0445\u043e\u0442|\u043d\u0430\u0445\u0443\u0439|\u0441\u0443\u043a\u0430|\u0440\u0430\u0437\u044a\u0435\u0431|\u0434\u043e\u043b\u0431\u0438|\u043a\u0440\u043e\u0448|\u043b\u043e\u043c\u0430\u044e|\u044f\u0440\u043e\u0441\u0442|\u0433\u043d\u0435\u0432|\u0438\u0441\u0442\u0435\u0440\u0438|\u0445\u0430\u043e\u0441|\u0434\u0438\u043a[\u0438\u043e]/,
  ],
  [
    'big',
    /\bbig\b|giant|massive|king|queen|crown|throne|forever|always|loud|shout|world|empire|power|\bgod\b|legend|champion|victory|triumph|titan|icon|best|first|everything|corona|mundo|poder|couronne|monde|krone|welt|macht|\u043a\u043e\u0440\u043e\u043b|\u0446\u0430\u0440[\u044c\u0438\u044f]|\u0442\u0440\u043e\u043d|\u043a\u043e\u0440\u043e\u043d|\u043b\u0435\u0433\u0435\u043d\u0434|^\u0431\u043e\u0433(?:\u0430|\u0443|\u0438|\u043e\u043c)?$|\u0432\u0435\u043b\u0438\u0447|\u0432\u044b\u0448\u0435|\u0431\u043e\u043b\u044c\u0448|\u0441\u0438\u043b\u044c\u043d|\u0433\u0440\u043e\u043c\u0447|\u043a\u0440\u0438\u043a|\u043a\u0440\u0438\u0447|\u043d\u0430\u0432\u0441\u0435\u0433\u0434|\u0432\u0441\u0435\u0433\u0434\u0430|\u043c\u043e\u0449\u044c|\u0438\u043c\u043f\u0435\u0440\u0438|\u043f\u043e\u0431\u0435\u0434|\u0447\u0435\u043c\u043f\u0438\u043e\u043d|\u0442\u0440\u0438\u0443\u043c\u0444|\u0442\u0438\u0442\u0430\u043d|^\u043c\u0438\u0440(?:\u0430|\u0443|\u043e\u043c|\u0435)?$|\u043f\u0435\u0440\u0432[\u044b\u0430]|\u043b\u0443\u0447\u0448/,
  ],
]

const STOP_WORDS = new Set([
  'это', 'как', 'что', 'где', 'кто', 'когда', 'почему', 'меня', 'тебя', 'тебе', 'мне', 'нами', 'вами',
  'него', 'нее', 'свой', 'своя', 'свою', 'очень', 'просто', 'только', 'даже', 'если', 'хотя', 'быть', 'была', 'было',
  'были', 'будет', 'этого', 'этом', 'этой', 'здесь', 'туда', 'сюда', 'пока', 'потом', 'через', 'после', 'перед',
  'this', 'that', 'with', 'from', 'your', 'they', 'have', 'been', 'just', 'like', 'what', 'when', 'where', 'there',
  'their', 'them', 'then', 'than', 'were', 'will', 'would', 'could', 'about', 'into', 'only', 'very',
])

const FALLBACK_MOODS: readonly WordFx[] = ['glow', 'ripple', 'neon', 'orbit']

interface EmojiPalette {
  rules?: readonly [RegExp, string][]
  defaults: readonly string[]
}

const EMOJI_PALETTES: Record<WordFx, EmojiPalette> = {
  cash: {
    rules: [
      [/\u0431\u0435\u043d\u0442\u043b|\u043c\u0430\u0439\u0431\u0430\u0445|\u043b\u0430\u043c\u0431\u043e|\u0444\u0435\u0440\u0440\u0430\u0440\u0438|\u043f\u043e\u0440\u0448|\u0433\u0435\u043b\u0438\u043a|\u044f\u0445\u0442|bentley|lambo|ferrari|porsche|maybach|yacht/, '\uD83C\uDFCE\uFE0F'],
      [/\u043b\u044e\u043a\u0441|\u043b\u0430\u043a\u0448\u0435\u0440|\u0433\u0443\u0447\u0447\u0438|\u043f\u0440\u0430\u0434\u0430|\u043a\u0430\u0440\u0442\u044c\u0435|\u0440\u043e\u043b\u0435\u043a\u0441|\u043a\u0430\u0440\u0430\u0442|luxury|gucci|prada|versace|balenci|cartier|rolex|bling|drip/, '\uD83D\uDC8E'],
      [/\u043c\u043e\u043d\u0435\u0442|\u043a\u0440\u0438\u043f\u0442|\u0431\u0438\u0442\u043a\u043e\u0438\u043d|coin|crypto|bitcoin|wealth|riches/, '\uD83E\uDE99'],
      [/\u0434\u0435\u043d\u044c\u0433|\u0434\u0435\u043d\u0435\u0433|\u043d\u0430\u043b\u0438\u0447|\u0434\u043e\u043b\u043b\u0430\u0440|\u0431\u0430\u043a\u0441|\u043a\u0443\u043f\u044e\u0440|\u0431\u0430\u043d\u043a\u043d\u043e\u0442|dollar|bucks|money|dinero|geld|argent/, '\uD83D\uDCB5'],
    ],
    defaults: ['\uD83D\uDCB8', '\uD83D\uDCB5', '\uD83E\uDE99'],
  },
  fire: {
    rules: [[/\u0434\u044c\u044f\u0432\u043e\u043b|\u0434\u0435\u043c\u043e\u043d|\u0430\u0434|hell|demon|devil|inferno|teufel/, '\uD83D\uDE08']],
    defaults: ['\uD83D\uDD25', '\u2764\uFE0F\u200D\uD83D\uDD25'],
  },
  ice: {
    defaults: ['\u2744\uFE0F', '\uD83E\uDDCA'],
  },
  rain: {
    rules: [
      [/\u043e\u043a\u0435\u0430\u043d|\u043c\u043e\u0440|ocean|sea|tsunami/, '\uD83C\uDF0A'],
      [/\u0433\u0440\u043e\u0437|\u0448\u0442\u043e\u0440\u043c|storm|tormenta|orage/, '\u26C8\uFE0F'],
      [/\u0441\u043b\u0435\u0437|\u043f\u043b\u0430\u0447|\u0440\u044b\u0434|tear|cry|weep|lagrima|trane/, '\uD83D\uDCA7'],
    ],
    defaults: ['\uD83C\uDF27\uFE0F', '\uD83D\uDCA7'],
  },
  heart: {
    rules: [
      [/\u0431\u043e\u043b|\u0440\u0430\u0437\u0431\u0438\u043b|\u043e\u0441\u043a\u043e\u043b\u043a|hurt|ache/, '\uD83D\uDC94'],
      [/\u043f\u043e\u0446\u0435\u043b|\u0446\u0435\u043b\u0443|kiss|beso|baiser|kuss/, '\uD83D\uDC8B'],
    ],
    defaults: ['\u2764\uFE0F\u200D\uD83D\uDD25', '\uD83D\uDC96'],
  },
  flash: {
    rules: [[/\u0432\u0437\u0440\u044b\u0432|\u0431\u044d\u043d\u0433|\u0441\u0430\u043b\u044e\u0442|explod|boom|bang/, '\uD83D\uDCA5']],
    defaults: ['\u26A1', '\u2728'],
  },
  glow: {
    rules: [
      [/\u043b\u0443\u043d|moon/, '\uD83C\uDF19'],
      [/\u0441\u043e\u043b\u043d|\u0437\u0430\u0440|\u0440\u0430\u0441\u0441\u0432\u0435\u0442|\u0437\u0430\u043a\u0430\u0442|sun|sol|soleil|sonne/, '\u2600\uFE0F'],
      [/\u0430\u043d\u0433\u0435\u043b|\u0440\u0430[\u0439\u044e\u044f\u0435]|\u043d\u0438\u043c\u0431|angel|heaven|halo|engel/, '\uD83E\uDEBD'],
    ],
    defaults: ['\u2728', '\uD83C\uDF1F'],
  },
  neon: {
    rules: [[/\u043a\u043b\u0443\u0431|\u0434\u0438\u0441\u043a|\u0440\u0435\u0439\u0432|club|disco|rave/, '\uD83E\uDEA9']],
    defaults: ['\uD83C\uDF03', '\uD83E\uDEA9'],
  },
  metal: {
    rules: [
      [/\u0430\u043b\u043c\u0430\u0437|\u0431\u0440\u0438\u043b\u043b|diamond|diamant/, '\uD83D\uDC8E'],
      [/\u0446\u0435\u043f|chain/, '\u26D3\uFE0F'],
    ],
    defaults: ['\uD83D\uDC8E', '\uD83D\uDEE1\uFE0F'],
  },
  rush: {
    rules: [
      [/\u043b\u0435\u0442|\u043b\u0435\u0447|\u043a\u0440\u044b\u043b|fly|flight|wings|vuelo|voler/, '\uD83E\uDEBD'],
      [/\u0434\u0440\u0438\u0444\u0442|\u0442\u0443\u0440\u0431\u043e|\u043d\u0438\u0442\u0440\u043e|\u0433\u043e\u043d|turbo|nitro|drift|race|drive/, '\uD83C\uDFCE\uFE0F'],
    ],
    defaults: ['\uD83D\uDCA8', '\u26A1'],
  },
  ripple: {
    rules: [
      [/\u0432\u0440\u0435\u043c|\u0447\u0430\u0441|\u0441\u0435\u043a\u0443\u043d\u0434|\u043c\u0438\u043d\u0443\u0442|\u0442\u0438\u043a|\u0442\u0430\u043a|time|clock|tick|hour|tiempo|temps|zeit/, '\u23F3'],
      [/\u0432\u043e\u043b\u043d|wave|ola|onde|welle/, '\uD83C\uDF0A'],
    ],
    defaults: ['\uD83C\uDF00', '\u23F3'],
  },
  big: {
    rules: [[/\u043f\u043e\u0431\u0435\u0434|\u0447\u0435\u043c\u043f\u0438|\u0442\u0440\u0438\u0443\u043c\u0444|victory|champion|triumph/, '\uD83C\uDFC6']],
    defaults: ['\uD83D\uDC51', '\uD83D\uDCA5'],
  },
  glitch: {
    defaults: ['\uD83D\uDC7E', '\uD83D\uDCE1'],
  },
  poison: {
    rules: [
      [/\u0432\u0438\u043d|\u0432\u0438\u0441\u043a|\u0442\u0435\u043a\u0438\u043b|\u0432\u043e\u0434\u043a|\u0448\u0430\u043c\u043f|\u043f\u044c\u044f\u043d|\u0432\u044b\u043f\u0438|wine|whiskey|vodka|tequila|champagne|drunk|wasted/, '\uD83C\uDF77'],
      [/\u0437\u043c\u0435|\u0432\u0435\u043d\u043e\u043c|snake|venom|bite/, '\uD83D\uDC0D'],
    ],
    defaults: ['\uD83E\uDDEA', '\u2620\uFE0F'],
  },
  slash: {
    rules: [[/\u043a\u0440\u043e\u0432|blood|bleed|sangre|blut|sang/, '\uD83E\uDE78']],
    defaults: ['\uD83D\uDDE1\uFE0F', '\u2694\uFE0F'],
  },
  smoke: {
    defaults: ['\uD83D\uDCA8', '\uD83C\uDF2B\uFE0F'],
  },
  orbit: {
    rules: [[/\u043a\u043e\u0441\u043c|\u0432\u0441\u0435\u043b|\u0433\u0430\u043b\u0430|space|cosmos|galax|univers/, '\uD83C\uDF0C']],
    defaults: ['\uD83E\uDE90', '\uD83C\uDF0C'],
  },
  bounce: {
    rules: [[/\u0442\u0430\u043d\u0446|\u0442\u0443\u0441|dance|party|bailar/, '\uD83E\uDEA9']],
    defaults: ['\uD83D\uDD0A', '\uD83C\uDFB5'],
  },
  fade: {
    rules: [[/\u0441\u043e\u043d|\u0441\u043d\u044b|\u0441\u043d\u0430\u0445|dream|sleep/, '\uD83C\uDF19']],
    defaults: ['\uD83E\uDEE7', '\uD83C\uDF19'],
  },
  shake: {
    defaults: ['\uD83D\uDCA5', '\uD83D\uDCA2'],
  },
}

function normalizeToken(rawWord: string): string {
  return rawWord
    .toLowerCase()
    .replace(/\u0451/g, '\u0435')
    .replace(/[^\p{L}\p{N}-]+/gu, '')
}

export function classifyWordFx(rawWord: string): WordFx | undefined {
  const clean = normalizeToken(rawWord)
  if (clean.length < 2) return undefined
  for (const [fx, re] of WORD_RULES) {
    if (re.test(clean)) return fx
  }
  return undefined
}

export function classifyWordEmoji(rawWord: string, fx: WordFx, indexSeed = 0): string {
  const clean = normalizeToken(rawWord)
  const palette = EMOJI_PALETTES[fx]
  if (palette.rules) {
    for (const [re, emoji] of palette.rules) {
      if (re.test(clean)) return emoji
    }
  }
  return palette.defaults[Math.abs(indexSeed) % palette.defaults.length]!
}

function splitTokens(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean)
}

function pickPoeticFallbackIndex(tokens: string[], taken: Set<number>): number {
  let bestIdx = -1
  let bestLen = 0
  for (let wi = tokens.length - 1; wi >= 0; wi--) {
    if (taken.has(wi)) continue
    const norm = normalizeToken(tokens[wi] ?? '')
    if (norm.length < 4 || STOP_WORDS.has(norm)) continue
    // Slightly prefer end-of-phrase focal words (natural rhyme/cadence landing)
    const score = norm.length + (wi === tokens.length - 1 ? 1.5 : 0)
    if (score > bestLen) {
      bestLen = score
      bestIdx = wi
    }
  }
  return bestIdx
}

function detectLineFx(text: string, tokens: string[], matches: Map<number, WordFx>): WordFx | undefined {
  const upperWords = tokens.filter((t) => {
    const letters = t.replace(/[^\p{L}]/gu, '')
    return letters.length >= 3 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()
  })
  if (/[!]{1,3}\s*$/.test(text) || upperWords.length >= 2) return 'big'

  const counts = new Map<WordFx, number>()
  for (const fx of matches.values()) counts.set(fx, (counts.get(fx) ?? 0) + 1)
  for (const [fx, c] of counts) {
    if (c >= 2) return fx
  }
  if (tokens.length <= 2 && matches.size >= 1) return matches.values().next().value
  return undefined
}

export function analyzeLyricsOffline(lines: LyricsLine[]): LyricsAnalysis {
  const lineFx = new Map<number, AnalyzedLine>()
  const stemRepeatCounts = new Map<string, number>()
  let lastMood: WordFx = 'glow'

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const tokens = line.words?.length ? line.words.map((w) => w.text) : splitTokens(line.text)
    const rawMatches = new Map<number, WordFx>()

    for (let wi = 0; wi < tokens.length; wi++) {
      const tok = tokens[wi]!
      const fx =
        classifyWordFx(tok) ??
        (tok.includes('-')
          ? tok
              .split('-')
              .map((part) => classifyWordFx(part))
              .find((v): v is WordFx => !!v)
          : undefined)
      if (fx) rawMatches.set(wi, fx)
    }

    const maxPerLine = Math.min(6, Math.max(3, Math.ceil(tokens.length * 0.72)))
    const wordFx = new Map<number, WordFx>()
    for (const [wi, fx] of rawMatches) {
      if (wordFx.size >= maxPerLine) break
      wordFx.set(wi, fx)
      lastMood = fx
    }

    // Keep verse lines alive without flooding prepositions: pick focal word using stanza mood when dictionary has <= 1 hit on longer lines.
    const minAnchorTarget = tokens.length >= 6 ? 2 : tokens.length >= 2 ? 1 : 0
    if (wordFx.size < minAnchorTarget) {
      const taken = new Set(wordFx.keys())
      let added = 0
      while (wordFx.size < minAnchorTarget && added < 2) {
        const anchorIdx = pickPoeticFallbackIndex(tokens, taken)
        if (anchorIdx < 0) break
        taken.add(anchorIdx)
        const mood = FALLBACK_MOODS[(i + anchorIdx) % FALLBACK_MOODS.length]!
        const chosenFx = wordFx.size > 0 ? lastMood : i % 2 === 0 ? lastMood : mood
        wordFx.set(anchorIdx, chosenFx)
        added++
      }
    }

    // Assign rotating choreography variant (0..3) per repeated word stem so choruses never feel repetitive.
    const wordVariant = new Map<number, FxVariant>()
    for (const [wi, fx] of wordFx) {
      const norm = normalizeToken(tokens[wi] ?? '')
      const stemKey = `${fx}:${norm.slice(0, 5) || wi}`
      const occ = stemRepeatCounts.get(stemKey) ?? 0
      stemRepeatCounts.set(stemKey, occ + 1)
      wordVariant.set(wi, (occ % 4) as FxVariant)
    }

    // Reserve floating emojis for select hero words; beam/3D/echo/canvas bursts carry the rest without visual clutter.
    const maxEmojis = tokens.length >= 7 ? 2 : 1
    const wordEmoji = new Map<number, string>()
    const usedEmojis = new Set<string>()
    for (const [wi, fx] of wordFx) {
      if (wordEmoji.size >= maxEmojis) break
      const isDirectMatch = rawMatches.has(wi)
      if (!isDirectMatch) continue
      const v = wordVariant.get(wi) ?? 0
      if (wordEmoji.size > 0 && v % 2 === 1) continue
      const emoji = classifyWordEmoji(tokens[wi] ?? '', fx, i + wi)
      if (usedEmojis.has(emoji)) continue
      usedEmojis.add(emoji)
      wordEmoji.set(wi, emoji)
    }

    const textFx = detectLineFx(line.text, tokens, wordFx)
    lineFx.set(i, { textFx, wordFx, wordVariant, wordEmoji })
  }

  return { lineFx }
}

export function describeLyricsMethod(
  lyrics: Lyrics | null | undefined,
  effectsEnabled: boolean,
  fromVk: boolean,
): LyricsMethodInfo {
  const cr = lyrics?.credits ?? ''
  let sourceLabel = '\u0412\u041a\u043e\u043d\u0442\u0430\u043a\u0442\u0435'
  if (lyrics?.source === 'spotify' || cr.includes('Spotify')) sourceLabel = 'Spotify'
  else if (lyrics?.source === 'netease' || cr.includes('NetEase')) sourceLabel = 'NetEase'
  else if (lyrics?.source === 'lrclib' || cr.includes('LRCLIB')) sourceLabel = 'LRCLIB'
  else if (lyrics?.source === 'kugou' || cr.includes('Kugou')) sourceLabel = 'Kugou'
  else if (lyrics?.source === 'qq' || cr.includes('QQ')) sourceLabel = 'QQ Music'
  else if (lyrics?.source === 'genius' || cr.includes('Genius')) sourceLabel = 'Genius'
  else if (lyrics?.source === 'ovh' || cr.includes('Lyrics.ovh')) sourceLabel = 'Lyrics.ovh'
  else if (lyrics?.source === 'vk' || fromVk || cr.includes('\u0412\u041a\u043e\u043d\u0442\u0430\u043a\u0442\u0435')) sourceLabel = '\u0412\u041a\u043e\u043d\u0442\u0430\u043a\u0442\u0435'

  const hasWords = !!lyrics?.lines.some((l) => l.words && l.words.length > 0)
  const syncLabel = hasWords ? '\u041f\u043e \u0441\u043b\u043e\u0432\u0430\u043c' : lyrics?.synced ? '\u041f\u043e \u0441\u0442\u0440\u043e\u043a\u0430\u043c' : '\u0411\u0435\u0437 \u0442\u0430\u0439\u043c\u0438\u043d\u0433\u043e\u0432'
  const fxLabel = effectsEnabled ? '\u041a\u0438\u043d\u0435\u043c\u0430\u0442\u043e\u0433\u0440\u0430\u0444' : '\u0411\u0435\u0437 \u044d\u0444\u0444\u0435\u043a\u0442\u043e\u0432'

  return { sourceLabel, syncLabel, fxLabel }
}
