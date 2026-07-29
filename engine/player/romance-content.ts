/**
 * Authored romance content for Hollowmere.
 *
 * The routes are deliberately plot-facing. Maren and Rowan are not rewards
 * waiting outside the murder story: what the player asks them to risk changes
 * rumor heat, faction posture, and which truths enter the player's record.
 * Every route remains independent. A commitment to one never closes the other.
 */

export const ROMANCE_AGENT_KEYS = ['maren_aldreth', 'rowan_corvane'] as const;
export type RomanceAgentKey = typeof ROMANCE_AGENT_KEYS[number];

export type RomanceStatus =
  | 'open'
  | 'growing'
  | 'courting'
  | 'committed'
  | 'platonic'
  | 'complicated'
  | 'strained';

export interface RomanceChoiceEffects {
  trust: number;
  affinity: number;
  respect: number;
  fear?: number;
  reputation?: number;
  globalTension?: number;
  factionTension?: number;
  rumorHeat?: { claimKey: string; amount: number };
  revealClaimKeys?: readonly string[];
  negotiation?: boolean;
  status?: RomanceStatus;
}

export interface RomanceChoiceDef {
  key: string;
  label: string;
  intent: string;
  flag: string;
  response: string;
  crisisResponse?: string;
  aftermath: string;
  impression: string;
  effects: RomanceChoiceEffects;
}

export interface RomanceSceneDef {
  key: string;
  chapter: number;
  title: string;
  kicker: string;
  minimum: { trust: number; affinity: number; respect: number };
  narration: string;
  crisisNarration?: string;
  opening: string;
  crisisOpening?: string;
  callbacks?: readonly { flag: string; text: string }[];
  choices: readonly RomanceChoiceDef[];
}

export interface RomanceProfile {
  routeTitle: string;
  role: string;
  publicFace: string;
  privateSelf: string;
  centralWound: string;
  deepestWant: string;
  contradiction: string;
  humor: string;
  affectionStyle: string;
  conflictStyle: string;
  boundaries: readonly string[];
  tells: readonly string[];
  plotRole: string;
  actionLogic: readonly string[];
}

export interface RomanceCandidateDef {
  agentKey: RomanceAgentKey;
  name: string;
  shortName: string;
  pronouns: { subject: string; object: string; possessive: string };
  factionKey: 'aldreth' | 'corvane';
  profile: RomanceProfile;
  scenes: readonly RomanceSceneDef[];
  epilogues: Record<'peace' | 'war' | 'exposed' | 'expired' | 'unfinished', Record<string, string>>;
}

const MAREN: RomanceCandidateDef = {
  agentKey: 'maren_aldreth',
  name: 'Lady Maren Aldreth',
  shortName: 'Maren',
  pronouns: { subject: 'she', object: 'her', possessive: 'her' },
  factionKey: 'aldreth',
  profile: {
    routeTitle: 'Salt on the Window',
    role: 'The newly made heir of House Aldreth, carrying a dead brother\'s title while the harbour waits to see whether she will become a ruler or a weapon.',
    publicFace: 'Immaculately composed, economical with praise, and almost impossible to embarrass in public. She treats every room as a negotiation because most rooms have treated her as a future marriage contract.',
    privateSelf: 'Restless, dryly funny, and hungry for one place where she does not have to perform competence. Grief makes her sleepless rather than tearful; when frightened, she begins arranging objects into straight lines.',
    centralWound: 'Edryc loved her, but he also kept protecting her by keeping her ignorant. His death left her both bereaved and furious that everyone still assumes a woman must be shielded from the machinery of her own house.',
    deepestWant: 'To be chosen with full knowledge of her ambition—not rescued from power, flattered for holding it, or loved only when she is soft.',
    contradiction: 'She believes truth is the only foundation that lasts, yet her first instinct is to control when and how truth is released. She can be genuinely tender while still calculating the cost of tenderness.',
    humor: 'Knife-dry observations delivered with a perfectly serious face. The more she trusts someone, the more willing she is to let them notice the joke.',
    affectionStyle: 'Attention as devotion: remembering an exact phrase, making room beside her without announcing it, and trusting someone with an unfinished thought. In private, touch begins cautiously and becomes very sure once welcomed.',
    conflictStyle: 'She goes colder, quieter, and more formal. Honest disagreement earns respect; public humiliation, possessiveness, or using her grief as leverage closes her off quickly.',
    boundaries: [
      'She will not be treated as a prize attached to House Aldreth.',
      'She can forgive disagreement more readily than manipulation disguised as protection.',
      'Edryc\'s memory is not a shortcut to intimacy; the player must let her decide when grief is shared.',
    ],
    tells: [
      'Squares papers and cups when she is trying not to show fear.',
      'Uses a person\'s given name only when the conversation has become private to her.',
      'Touches the Aldreth signet when she is speaking as heir; removes her hand from it when speaking as herself.',
    ],
    plotRole: 'Maren controls Aldreth\'s willingness to negotiate and possesses fragments of Edryc\'s audit. Loving her can make truth easier to reach, but asking her to betray her people for affection can harden the entire harbour.',
    actionLogic: [
      'Under low tension she gathers information and tests whether the player can separate sympathy from obedience.',
      'Under accusations she protects workers first, reputation second, and her own safety last—though she will claim the reverse.',
      'After first blood she becomes willing to expose Aldreth crimes if doing so can stop retaliation, but only a trusted player can keep that choice from feeling like surrender.',
    ],
  },
  scenes: [
    {
      key: 'maren_rain_between_bells', chapter: 1, title: 'The Rain Between Bells',
      kicker: 'An unguarded minute', minimum: { trust: 5000, affinity: 0, respect: 0 },
      narration: 'The rain has driven everyone beneath an awning except Maren. She stands at its edge, gloveless, letting cold water gather in her palm as though testing whether the day is real.',
      crisisNarration: 'A bell has been ringing names of the detained. Maren stands outside its shelter anyway, rain silvering her hair while armed footsteps pass at the end of the street.',
      opening: '“They keep telling me I must not be alone.” Her mouth turns, almost a smile. “No one has asked whether company is helping.”',
      crisisOpening: '“Every messenger brings me a fresh disaster and waits to see whether I flinch.” She looks at you then. “I am very tired of being watched for weakness.”',
      choices: [
        {
          key: 'share_silence', label: 'Stand beside her without filling the silence.',
          intent: 'Offer presence without asking Maren to perform grief for you.', flag: 'maren_grief_given_space',
          response: 'For a while she says nothing. Then her shoulder rests against yours, lightly enough to be withdrawn. “You may be the first person today who has not asked me to become useful.”',
          crisisResponse: 'She watches the street while you keep watch with her. At last, some locked place in her posture eases. “Stay until the next bell. I would like one sound not to mean I have failed someone.”',
          aftermath: 'Maren remembers that you did not demand a confession in exchange for kindness.',
          impression: 'The outsider gave Maren silence without abandoning her to it.',
          effects: { trust: 450, affinity: 500, respect: 150 },
        },
        {
          key: 'ask_for_edryc', label: '“Tell me who Edryc was when no one was looking.”',
          intent: 'Invite a human memory rather than another account of the murder.', flag: 'maren_edryc_remembered',
          response: 'Surprise softens her face. “He sang terribly. Only at sea, and only when he believed the wind could be blamed.” The laugh that escapes her hurts, but it is real. “Thank you for asking about the living part of him.”',
          crisisResponse: 'Her answer comes slowly. “He cheated at cards and confessed before anyone noticed. Imagine that—a man constitutionally incapable of enjoying his own crime.” Her eyes shine. “I needed to remember that before they turn him into a banner.”',
          aftermath: 'Edryc becomes a person between you, not merely evidence or a title Maren inherited.',
          impression: 'The outsider asked Maren to remember Edryc as a brother, not a corpse.',
          effects: { trust: 350, affinity: 450, respect: 250, revealClaimKeys: ['maren_welcomed_it'], rumorHeat: { claimKey: 'maren_welcomed_it', amount: -500 } },
        },
        {
          key: 'promise_aldreth', label: '“You should not have to carry your house alone.”',
          intent: 'Offer political solidarity, even if Maren is unsure whether it is personal.', flag: 'maren_house_promise',
          response: 'Her expression becomes careful. “That is kind. It is also a promise people make when they want a place near the throne.” She studies you. “I will remember that you made it before knowing what it costs.”',
          crisisResponse: '“Then do not love the idea of us,” she says. “Look at what we have done, and decide whether you can still stand near me.” The challenge is severe; the hope beneath it is not.',
          aftermath: 'Maren accepts the offer, but keeps one hand on the question of what you expect in return.',
          impression: 'The outsider promised to help carry House Aldreth; Maren is grateful and wary.',
          effects: { trust: 200, affinity: 200, respect: 350, reputation: 350 },
        },
      ],
    },
    {
      key: 'maren_ledger_margin', chapter: 2, title: 'In the Ledger Margin',
      kicker: 'What Edryc left unfinished', minimum: { trust: 5200, affinity: 250, respect: 100 },
      narration: 'Maren draws a folded scrap from inside her sleeve. The paper is covered in Edryc\'s narrow hand: grain totals, tide marks, and one line written twice—trust the margin, not the sum.',
      crisisNarration: 'Maren has carried the scrap through two searches and one attempted arrest. The edges are soft with handling. Whatever is written there has become dangerous enough to kill for twice.',
      opening: '“I can give this to the magistrate, bury it, or use it to force half the council to kneel.” She meets your eyes. “I know what the heir should do. I am asking what you believe I should do.”',
      crisisOpening: '“If this goes public tonight, my house may fracture by morning. If it does not, someone innocent may hang.” Her voice remains level. Her hands do not. “Tell me the truth, not what will keep me fond of you.”',
      callbacks: [
        { flag: 'maren_grief_given_space', text: 'Because you once let silence be enough, she does not rush to fill this one.' },
        { flag: 'maren_house_promise', text: 'The promise you made to help carry her house is present between you now, heavier than either of you expected.' },
      ],
      choices: [
        {
          key: 'give_magistrate', label: '“Give Veranne a copy. Keep the original safe.”',
          intent: 'Choose accountable truth without asking Maren to surrender every defense.', flag: 'maren_chose_accountable_truth',
          response: 'Maren exhales. “A copy gives the law a chance and denies it the power to erase what does not suit it.” She folds the page once. “That is not a clean answer. I trust it more for being honest about that.”',
          crisisResponse: '“Then we divide the risk.” Her fingers close around yours for one brief, fierce moment. “If the law fails, at least it will not take the truth with it.”',
          aftermath: 'The audit trail enters the investigation while Maren retains proof against anyone who would suppress it.',
          impression: 'The outsider helped Maren choose accountable truth over control.',
          effects: { trust: 500, affinity: 300, respect: 600, globalTension: -250, factionTension: -200, revealClaimKeys: ['granary_books_false'], rumorHeat: { claimKey: 'granary_books_false', amount: 650 } },
        },
        {
          key: 'keep_between_us', label: '“Keep it tonight. Decide when the town is less hungry for blood.”',
          intent: 'Protect Maren and the evidence, accepting that delay has a moral cost.', flag: 'maren_delayed_audit',
          response: '“Prudence,” she says, though the word sounds like a question. She tucks the paper away. “Stay near me tonight. If I am choosing fear, I want one person present who will name it honestly.”',
          crisisResponse: 'She leans close enough that her forehead nearly touches yours. “One night. Not forever.” Relief and shame cross her face together. “Do not let tenderness turn either of us into a coward.”',
          aftermath: 'The evidence remains safe and private. Maren feels protected, but the public truth waits.',
          impression: 'The outsider protected Maren and Edryc’s note, while promising not to confuse delay with innocence.',
          effects: { trust: 400, affinity: 550, respect: 100, reputation: 250, globalTension: 100, revealClaimKeys: ['granary_books_false'] },
        },
        {
          key: 'use_as_leverage', label: '“Use it. Make both houses answer to you.”',
          intent: 'Encourage Maren to turn the evidence into political power.', flag: 'maren_weaponized_audit',
          response: 'The heir in her understands immediately. The woman beside you looks disappointed that you do. “Efficient,” she says. “And perhaps necessary. But do not mistake helping me win for knowing me.”',
          crisisResponse: '“There it is.” Her voice goes very quiet. “The answer everyone gives when they decide power is the only language I speak.” She takes the paper back. “I may use it. I will not thank you for making it easier.”',
          aftermath: 'Maren gains leverage over the council, while trust between you becomes more transactional.',
          impression: 'The outsider urged Maren to weaponize Edryc’s evidence; she respected the ruthlessness and mistrusted the intimacy.',
          effects: { trust: -250, affinity: -200, respect: 500, fear: 100, reputation: 500, globalTension: 300, status: 'strained', revealClaimKeys: ['granary_books_false'] },
        },
      ],
    },
    {
      key: 'maren_name_without_title', chapter: 3, title: 'A Name Without a Title',
      kicker: 'The person beneath the office', minimum: { trust: 5400, affinity: 550, respect: 250 },
      narration: 'The household has gone to bed. Maren has taken off the Aldreth signet and set it between you. Without it, the pale mark around her finger looks startlingly intimate.',
      crisisNarration: 'Outside, the watch changes early and too loudly. Maren removes her signet as if it has begun to burn, placing the weight of her house on the table instead of her hand.',
      opening: '“If Edryc had lived, I might have spent my life being useful in rooms where no one remembered I had a first name.” She looks down at the ring. “I do not know whether to mourn that life or envy it.”',
      crisisOpening: '“Maren,” she says, almost testing the sound. “For this hour I need to be Maren. Not my brother\'s successor. Not the harbour\'s answer to a threat. Can you speak to that woman?”',
      callbacks: [
        { flag: 'maren_edryc_remembered', text: 'You remember the brother who sang badly into the sea, and the sister who allowed herself to laugh.' },
        { flag: 'maren_weaponized_audit', text: 'The distance left by your advice about the ledger has not vanished; offering closeness now will require humility rather than charm.' },
      ],
      choices: [
        {
          key: 'choose_maren', label: '“Maren. I want to know what you choose when no one is owed an answer.”',
          intent: 'See her as a person without asking her to surrender ambition.', flag: 'maren_seen_whole',
          response: 'Her eyes close for half a breath. “I would choose a door I can lock. A boat small enough to sail myself. And—” She looks at you. “Someone who does not need me diminished in order to feel close.”',
          crisisResponse: '“Then remember me,” she whispers. “If the town turns me into a villain or a saint, remember that I was difficult and frightened and trying.” Her hand opens on the table, waiting rather than reaching.',
          aftermath: 'Maren lets you see desires she considers too ordinary—and therefore too vulnerable—for public life.',
          impression: 'The outsider chose Maren without asking her to become smaller than Lady Aldreth.',
          effects: { trust: 550, affinity: 700, respect: 500, status: 'growing' },
        },
        {
          key: 'offer_escape', label: '“You could leave. I would go with you.”',
          intent: 'Offer escape before learning whether escape is what she wants.', flag: 'maren_offered_escape',
          response: 'Longing flashes across her face, then steadies. “Do not tempt me with a life that requires abandoning everyone who cannot afford one.” Her voice softens. “Ask me again someday—after we have saved something worth returning to.”',
          crisisResponse: 'She cups your cheek, tender and unbearably sad. “I want to say yes. That is why I cannot.” Her thumb moves once. “Help me make staying a choice, not a sentence.”',
          aftermath: 'The fantasy matters to her, but so does your willingness to understand why she cannot take it yet.',
          impression: 'The outsider offered Maren escape; she was moved, but refused to make love an abandonment.',
          effects: { trust: 250, affinity: 650, respect: -100, status: 'growing' },
        },
        {
          key: 'title_is_power', label: '“The title is yours now. Make it mean what you want.”',
          intent: 'Answer vulnerability with faith in her power rather than intimacy.', flag: 'maren_crowned_not_comforted',
          response: '“A good answer for daylight.” She slides the signet back onto her finger. “I was hoping, perhaps unfairly, for one that belonged to the dark.”',
          crisisResponse: 'The opening in her expression closes. “Yes. Of course.” Lady Aldreth returns so completely that you understand what was briefly offered—and what you missed.',
          aftermath: 'Maren values your confidence in her, but feels the private question went unanswered.',
          impression: 'The outsider affirmed Lady Aldreth when Maren had asked to be seen without the title.',
          effects: { trust: 50, affinity: -200, respect: 450, status: 'strained' },
        },
      ],
    },
    {
      key: 'maren_harbour_candle', chapter: 4, title: 'A Candle for the Harbour',
      kicker: 'Love under public consequence', minimum: { trust: 5600, affinity: 900, respect: 450 },
      narration: 'Maren has drafted two speeches. One admits that Aldreth ships carried weapons. The other condemns the allegation as Corvane theater. Both could save lives. Both could cost them.',
      crisisNarration: 'Smoke lies over the roofs. Maren has drafted no speech at all—only two sentences, one truthful and one useful, while the harbour crowd pounds on the doors below.',
      opening: '“If I confess what my house has done, I may stop the lie about poisoned grain. I may also put shipwrights on the scaffold.” She pushes both pages toward you. “What would you ask of me if you did not care whether I forgave you?”',
      crisisOpening: '“Choose with me,” she says. “Not for me. If we are to become anything to one another, I need to know whether you can share the blame for an imperfect mercy.”',
      callbacks: [
        { flag: 'maren_chose_accountable_truth', text: 'The copy of Edryc\'s note already sits with the magistrate. This decision will determine whether that act becomes a beginning or an exception.' },
        { flag: 'maren_delayed_audit', text: 'You once bought her a night of safety. That night has ended, and neither of you pretends otherwise.' },
      ],
      choices: [
        {
          key: 'truth_with_protection', label: '“Tell the truth—and name the workers you will protect before you name the crime.”',
          intent: 'Refuse the false choice between honesty and care.', flag: 'maren_public_truth_with_mercy',
          response: 'Maren reads the truthful page again. Then she writes a third opening above it: My house ordered the cargo. The hands that loaded it did not. “Stay near the front,” she says. “I will be braver if I can find you in the crowd.”',
          crisisResponse: 'She writes the workers\' names before her own. “If they come for someone, they come through me first.” Her gaze catches yours. “Through us, if you still mean to stand there.”',
          aftermath: 'Aldreth admits the arms landings while separating commanders from laborers, cooling the feud and strengthening the true investigation.',
          impression: 'The outsider helped Maren tell a dangerous truth without sacrificing powerless people to it.',
          effects: { trust: 650, affinity: 600, respect: 800, reputation: -200, globalTension: -650, factionTension: -550, rumorHeat: { claimKey: 'shipwrights_smuggle_arms', amount: 1000 }, revealClaimKeys: ['shipwrights_smuggle_arms'], negotiation: true, status: 'growing' },
        },
        {
          key: 'protect_harbour', label: '“Deny it until the town is safe enough to hear it.”',
          intent: 'Prioritize immediate stability and accept complicity in a lie.', flag: 'maren_protected_harbour_lie',
          response: '“I wanted you to say that.” The admission seems to frighten her more than the crowd. “Wanting it does not make it right.” She takes the denial. “When this is over, do not let me edit what we chose tonight.”',
          crisisResponse: 'Maren burns the confession over the candle. “Then this sin is ours, not yours offered as a gift to me.” She takes your hand as the paper curls. The intimacy is real; so is the smoke.',
          aftermath: 'The harbour closes ranks. Aldreth trusts you more, but a true thread of the investigation is weakened.',
          impression: 'The outsider shared responsibility for Maren’s protective lie about the harbour.',
          effects: { trust: 500, affinity: 750, respect: -200, reputation: 700, globalTension: 200, factionTension: -150, rumorHeat: { claimKey: 'shipwrights_smuggle_arms', amount: -850 }, revealClaimKeys: ['shipwrights_smuggle_arms'], status: 'complicated' },
        },
        {
          key: 'refuse_choice', label: '“This must be your decision. I will not carry it for you.”',
          intent: 'Protect yourself from responsibility when Maren explicitly asked to share it.', flag: 'maren_left_with_choice',
          response: '“No,” she says, not angrily. “You will only live with what follows.” She gathers both pages. “I did not ask you to rule. I asked whether I would be alone beside you.”',
          crisisResponse: 'Something in her face becomes still. “Then I have my answer to the more important question.” She turns toward the waiting doors without looking back.',
          aftermath: 'Maren makes the decision alone. Whatever happens publicly, the private bond is badly strained.',
          impression: 'The outsider withdrew when Maren asked them to share the moral weight of her choice.',
          effects: { trust: -700, affinity: -650, respect: -250, status: 'strained' },
        },
      ],
    },
    {
      key: 'maren_before_dawn', chapter: 5, title: 'Before the Town Wakes',
      kicker: 'Desire spoken plainly', minimum: { trust: 5900, affinity: 1250, respect: 600 },
      narration: 'Before dawn, Maren finds you where the roofs fall away toward the sea. There are no witnesses, no papers in her hands, and no title in the way she says your name.',
      crisisNarration: 'The horizon is red for reasons that have nothing to do with sunrise. Maren finds you anyway. For once, neither of you pretends there will be a safer hour.',
      opening: '“I have become accustomed to looking for you,” she says. “That is an inelegant way to admit something, but elegance has wasted enough of our time.”',
      crisisOpening: '“Tomorrow may ask me to be merciless.” Her fingers close around the front of your coat. “Tonight I need one honest thing that belongs to neither house.”',
      callbacks: [
        { flag: 'maren_seen_whole', text: 'She knows you have seen ambition and tenderness occupy the same heart—and did not ask either one to leave.' },
        { flag: 'maren_crowned_not_comforted', text: 'She is more guarded than she might have been. If you reach for her now, words will matter before touch.' },
      ],
      choices: [
        {
          key: 'kiss_maren', label: '“Then let it be us.” Ask, and kiss her when she says yes.',
          intent: 'Make the romantic choice clearly and consensually.', flag: 'maren_first_kiss',
          response: '“Yes,” Maren says before you finish asking. The first touch of her mouth is careful; the second is not. When you part, her forehead remains against yours. “There. No council vote. No seal. I chose you.”',
          crisisResponse: 'Her yes is fierce and immediate. She kisses you like someone refusing to let fear decide the shape of her last gentle memory. Afterward she holds you close, breathing hard. “Find me tomorrow,” she says. “Whatever name the town gives me.”',
          aftermath: 'You and Maren begin a romance openly between yourselves, with no claim of exclusivity over any other bond.',
          impression: 'Maren and the outsider chose a mutual romance, founded on truth rather than ownership.',
          effects: { trust: 700, affinity: 1000, respect: 500, status: 'courting' },
        },
        {
          key: 'hold_maren', label: 'Take her hand. “I am here. I do not need to name this tonight.”',
          intent: 'Offer tenderness without demanding a romantic definition.', flag: 'maren_tender_uncertainty',
          response: 'Her fingers thread through yours. “Most people rush to name a thing so they can begin deciding what it owes them.” She rests her head against your shoulder. “Let us owe this moment nothing but honesty.”',
          crisisResponse: 'She steps into your arms and allows herself to shake once, silently. “No vows made because we are afraid,” she murmurs. “Only this. This is enough for tonight.”',
          aftermath: 'The bond remains intimate and undefined, leaving room for either romance or enduring friendship.',
          impression: 'The outsider gave Maren tenderness without turning uncertainty into a demand.',
          effects: { trust: 650, affinity: 700, respect: 650, status: 'complicated' },
        },
        {
          key: 'choose_friendship', label: '“I love what we have, but not as a courtship.”',
          intent: 'Decline romance honestly without diminishing the bond.', flag: 'maren_chosen_friendship',
          response: 'Pain moves through her face, clean and brief. Then she nods. “Thank you for trusting me with an answer that does not flatter me.” Her hand squeezes yours before letting go. “Do not disappear out of embarrassment. I would miss you.”',
          crisisResponse: 'She closes her eyes, then gives a small, rueful laugh. “Even at the end of the world, honesty remains badly timed.” Her hand rests over your heart. “Stay my friend. That is not a lesser place.”',
          aftermath: 'Maren accepts a close friendship. The route remains meaningful and affects the plot without pretending friendship is failed romance.',
          impression: 'The outsider chose honest friendship with Maren, and she kept the bond without false hope.',
          effects: { trust: 800, affinity: 250, respect: 800, status: 'platonic' },
        },
      ],
    },
    {
      key: 'maren_two_keys', chapter: 6, title: 'Two Keys',
      kicker: 'A future with doors of its own', minimum: { trust: 6200, affinity: 1500, respect: 800 },
      narration: 'Maren places two small iron keys on the table. One opens a room in the Aldreth house. The other opens a weathered cottage above the shipyard that belongs to no title at all.',
      crisisNarration: 'Maren has salvaged two keys from a ring of blackened metal. One belongs to her house. The other belongs to a cottage the fighting has somehow missed.',
      opening: '“I will not ask you to become Aldreth,” she says. “And I will not pretend I can cease to be. But I would like you to have a door here that opens because you choose it.”',
      crisisOpening: '“I cannot promise safety. I can promise never to make a prison sound like devotion.” She separates the keys. “Tell me what kind of future I am allowed to hope for.”',
      callbacks: [
        { flag: 'maren_first_kiss', text: 'Her thumb brushes her lower lip before she catches herself; the private memory warms a very public decision.' },
        { flag: 'maren_chosen_friendship', text: 'There is no courtship presumed in the offer. The key is an act of belonging between friends, given without an unspoken bargain.' },
        { flag: 'maren_protected_harbour_lie', text: 'The lie you chose together remains between you. A future is possible, but it will require confession rather than romantic absolution.' },
      ],
      choices: [
        {
          key: 'build_shared_home', label: 'Take the cottage key. “A place that is ours, not your house or mine.”',
          intent: 'Commit to a shared life with boundaries around power and identity.', flag: 'maren_committed_future',
          response: 'Maren closes your fingers around the key and kisses your knuckles. “Ours,” she repeats, wonder briefly undoing her composure. “I have negotiated treaties with less terror than this.” Then she smiles. “And far less hope.”',
          crisisResponse: 'Her breath catches. She presses the key into your palm, then your joined hands against her heart. “If the cottage falls, we build another. I am finished believing home is something other people can revoke.”',
          aftermath: 'You commit to building a life with Maren that does not erase either person inside the alliance.',
          impression: 'Maren and the outsider committed to a shared future with room for love, duty, and separate selves.',
          effects: { trust: 900, affinity: 1200, respect: 800, globalTension: -300, factionTension: -350, negotiation: true, status: 'committed' },
        },
        {
          key: 'keep_own_door', label: 'Take neither. “I want you, and I need a door that remains mine.”',
          intent: 'Choose romance or closeness without merging lives or power.', flag: 'maren_independent_future',
          response: 'Maren studies you, then gathers the keys without offense. “Good.” A slow smile. “I would have worried if loving me made you careless with your freedom.” She leans across the table. “Keep your door. Invite me through it.”',
          crisisResponse: '“Then survive and show me where it is.” She kisses your brow. “Love should make more exits from a burning room, not fewer.”',
          aftermath: 'The relationship continues without shared residence or political identity; independence is treated as devotion, not rejection.',
          impression: 'Maren and the outsider chose a devoted bond that preserves separate homes and identities.',
          effects: { trust: 850, affinity: 850, respect: 1000, status: 'committed' },
        },
        {
          key: 'remain_beloved_allies', label: 'Return both keys. “Let us be the people who tell each other the truth.”',
          intent: 'Affirm a lasting platonic or complicated bond instead of a shared future.', flag: 'maren_beloved_ally',
          response: 'She covers the keys with her hand. “That may be the rarer vow.” Her smile is sad only at the edges. “Very well. When everyone else tells me what power wants to hear, you will be unwelcome and necessary.”',
          crisisResponse: '“Then promise me the truth even when it is the last kindness left.” She embraces you, formal for an instant and then not formal at all. “My dearest necessary nuisance.”',
          aftermath: 'You and Maren become enduring confidants whose honesty continues to shape Aldreth decisions.',
          impression: 'Maren and the outsider chose an enduring alliance built on unwelcome, necessary truth.',
          effects: { trust: 1000, affinity: 350, respect: 1100, globalTension: -200, factionTension: -250, negotiation: true, status: 'platonic' },
        },
      ],
    },
  ],
  epilogues: {
    peace: {
      committed: 'Maren signs the peace with salt still drying on the windows. She keeps both her title and the life you chose together; neither is permitted to swallow the other.',
      platonic: 'Maren becomes a difficult, patient architect of peace. Your place at her table is unofficial and indispensable: the person allowed to tell Lady Aldreth when Maren has disappeared behind the title.',
      default: 'Peace leaves room for what remains unresolved between you. Maren does not demand an answer; she asks only that the next conversation be honest.',
    },
    exposed: {
      committed: 'When the culprit is exposed, Maren refuses the easy story that one guilty person absolves two houses. She opens Edryc\'s ledgers, then comes home to the door you chose together.',
      platonic: 'Maren uses the exposure to force reforms no grieving heir was expected to attempt. Your friendship survives because neither of you lets victory rewrite the compromises that came before it.',
      default: 'The truth clears Edryc\'s name without simplifying his house. Maren meets you after the hearing, ready at last to discuss what the two of you might be when there is no crisis to hide inside.',
    },
    war: {
      committed: 'War makes every promise harder and therefore more deliberate. Maren turns Aldreth ships toward evacuation instead of conquest, carrying your key beneath her collar until there is a home to use it on.',
      platonic: 'Maren leads the harbour through war with your unwelcome counsel intact. You cannot save every life, but neither of you allows grief to become permission for cruelty.',
      default: 'War interrupts the answer between you. Maren remembers every kindness and every failure; if you meet again, the relationship will begin with the truth of both.',
    },
    expired: { default: 'Time runs out before Hollowmere resolves either its murder or the feeling between you. Maren leaves the question open, which is not the same as leaving it empty.' },
    unfinished: { default: 'Maren is still deciding whether you are a refuge, an ally, or a danger she has begun to want near her.' },
  },
};

const ROWAN: RomanceCandidateDef = {
  agentKey: 'rowan_corvane',
  name: 'Rowan Corvane',
  shortName: 'Rowan',
  pronouns: { subject: 'he', object: 'him', possessive: 'his' },
  factionKey: 'corvane',
  profile: {
    routeTitle: 'Where the River Keeps Its Name',
    role: 'The Corvane heir whose silence about the murder-night quay has made him the town\'s most convenient almost-suspect.',
    publicFace: 'Proud, sparse with words, and apparently indifferent to approval. He has learned that refusing to explain himself looks like strength to his father and guilt to everyone else.',
    privateSelf: 'Patient with damaged things, unexpectedly gentle, and almost painfully literal about promises. He dislikes courtly performance, laughs with his whole face when surprised, and becomes talkative when his hands are occupied.',
    centralWound: 'As a boy he told the truth about a Corvane overseer and watched the witness lose her livelihood while the guilty man kept his post. Since then he has confused secrecy with protection and self-sacrifice with honor.',
    deepestWant: 'To be trusted without being forced to expose someone more vulnerable as the price of proving his own innocence.',
    contradiction: 'He hates being judged by his name but uses that same name as a shield for others. He wants directness, yet makes people work around silences he considers noble.',
    humor: 'Quietly absurd, usually aimed at himself or at pompous traditions. He often hides a joke inside a factual sentence and waits to see whether the listener catches it.',
    affectionStyle: 'Practical care: repairing a buckle, walking the dangerous side of a road, bringing food without asking whether it is needed. Verbal affection arrives late but lands without hedging.',
    conflictStyle: 'He withdraws to prevent himself from saying something cruel, which can feel like punishment to the other person. He responds best to direct boundaries and worst to public tests of loyalty.',
    boundaries: [
      'He will not trade a vulnerable person\'s safety for his own reputation.',
      'He rejects affection used as interrogation; trust must leave room for a truthful “not yet.”',
      'He needs the player to challenge his martyrdom rather than romanticize it.',
    ],
    tells: [
      'Repairs or sharpens something when words feel dangerous.',
      'Looks directly at the player when telling an uncomfortable truth and away when receiving tenderness.',
      'Says “stay” instead of “I need you” until he learns that need is not a debt.',
    ],
    plotRole: 'Rowan can explain the true quay sighting, protect a crucial witness, and influence Corvane\'s willingness to stand down. Pressing him carelessly can feed the rumor against him; earning his trust gives the investigation a route around faction propaganda.',
    actionLogic: [
      'Under low tension he investigates quietly, prioritizing witness safety over clearing his name.',
      'Under accusations he accepts public suspicion until it begins endangering workers, then acts abruptly and without asking permission.',
      'After first blood he stops believing silence can protect anyone and becomes willing to testify, provided the player has not treated trust as ownership.',
    ],
  },
  scenes: [
    {
      key: 'rowan_broken_lantern', chapter: 1, title: 'The Broken Lantern',
      kicker: 'Care disguised as work', minimum: { trust: 5000, affinity: 0, respect: 0 },
      narration: 'Rowan sits on a low wall with a storm lantern in pieces across his coat. He has repaired the cracked hinge twice. It keeps failing because the metal around it is tired.',
      crisisNarration: 'The lantern was knocked from a watchman\'s hand during the night\'s arrests. Rowan works on it beneath shuttered windows, trying to mend one small light while the town tears at itself.',
      opening: '“If I stop moving my hands, people assume I am waiting to be questioned.” He tests the hinge. “If I keep moving them, they assume I am hiding nerves. Hollowmere is very efficient.”',
      crisisOpening: '“A boy on the night watch needs this back before dark.” Rowan does not look up. “I am aware there are larger emergencies. The larger ones are not accepting repairs.”',
      choices: [
        {
          key: 'hold_lantern', label: 'Hold the lantern steady without asking about the quay.',
          intent: 'Join his care for something small without making help a pretext for interrogation.', flag: 'rowan_helped_without_price',
          response: 'He glances at your hands, then at you. “Most people begin with the question and offer help afterward.” The new pin slides into place. “This order is better.”',
          crisisResponse: 'Your hands keep the frame from buckling while he sets the pin. “There,” he says softly when the light catches. “One thing that will work tonight because we were here.”',
          aftermath: 'Rowan remembers that your kindness did not arrive with a concealed demand.',
          impression: 'The outsider helped Rowan repair a lantern without charging him a confession.',
          effects: { trust: 500, affinity: 400, respect: 200 },
        },
        {
          key: 'name_suspicion', label: '“Your silence is hurting you. I am not saying you owe me the reason.”',
          intent: 'Name the consequence without claiming entitlement to his secret.', flag: 'rowan_silence_challenged_gently',
          response: 'His hands stop. “That is annoyingly fair.” A reluctant smile appears. “I was prepared to defend my right to silence. You have made me consider whether I am using it well.”',
          crisisResponse: '“It is hurting more people than me now.” He looks toward the square. “I know. I have known since the first arrest.” The admission is quiet and costly. “Thank you for leaving the door open instead of dragging me through it.”',
          aftermath: 'Rowan begins separating his right to privacy from the consequences of protective silence.',
          impression: 'The outsider challenged Rowan’s silence without treating his trust as something owed.',
          effects: { trust: 350, affinity: 300, respect: 550, rumorHeat: { claimKey: 'rowan_at_the_quay', amount: -250 } },
        },
        {
          key: 'demand_alibi', label: '“If you are innocent, prove it.”',
          intent: 'Make innocence conditional on disclosure.', flag: 'rowan_alibi_demanded',
          response: 'The hinge clicks shut. Rowan hands you the repaired lantern. “Innocence that requires me to purchase it with someone else\'s safety is not the kind you are offering.” He stands. “Keep the light. You seem certain you can see enough.”',
          crisisResponse: '“And there it is.” He rises, anger held on a very short rein. “The town\'s favorite bargain: give us someone smaller, and we may stop calling you guilty.”',
          aftermath: 'Rowan withdraws. He may forgive direct suspicion, but not the assumption that another person is acceptable collateral.',
          impression: 'The outsider demanded Rowan buy credibility with a secret he believed protected someone vulnerable.',
          effects: { trust: -550, affinity: -400, respect: -150, fear: 100, rumorHeat: { claimKey: 'rowan_at_the_quay', amount: 250 }, status: 'strained' },
        },
      ],
    },
    {
      key: 'rowan_tide_table', chapter: 2, title: 'What the Tide Carried',
      kicker: 'The shape of an alibi', minimum: { trust: 5200, affinity: 200, respect: 150 },
      narration: 'Rowan unfolds a tide table marked in Tobias Reeve\'s hand. One time is circled: the exact half hour before Edryc died. Beside it is a ferry token worn almost smooth.',
      crisisNarration: 'The tide table is damp with river water and blood that is not Rowan\'s. The circled time remains legible. So does the name of the ferryman everyone is now threatening.',
      opening: '“I was at the quay.” His gaze does not leave yours. “Caleb saw me. I kept quiet because saying so would send the house guard to his door—and because he saw something after I left.”',
      crisisOpening: '“Silence has stopped protecting him.” Rowan sets the token in your palm. “But if this enters the wrong hands, Caleb will be dead before he reaches a hearing. Tell me who gets the truth first.”',
      callbacks: [
        { flag: 'rowan_helped_without_price', text: 'Because you once helped without asking payment, this disclosure feels offered rather than extracted.' },
        { flag: 'rowan_alibi_demanded', text: 'The demand you made before still stands between you. Rowan is telling you despite it, not because trust has fully healed.' },
      ],
      choices: [
        {
          key: 'protect_then_testify', label: '“Move Caleb somewhere safe. Then both of you tell Veranne together.”',
          intent: 'Protect the witness without burying his testimony.', flag: 'rowan_witness_protected_for_truth',
          response: 'Relief makes Rowan look younger. “Safety first, truth second, and neither abandoned.” He closes your fingers around the token. “I have been trying to find that sentence for days.”',
          crisisResponse: '“I know a cellar beneath the old net loft.” He is already planning. Then he catches your wrist, not hard. “Come with me. I trust my judgment more when yours is near enough to argue.”',
          aftermath: 'Caleb\'s role in the murder night becomes part of the investigation without making him an undefended target.',
          impression: 'The outsider helped Rowan protect Caleb in order to preserve, not suppress, the truth.',
          effects: { trust: 600, affinity: 400, respect: 650, globalTension: -300, rumorHeat: { claimKey: 'ferryman_saw_it', amount: 750 }, revealClaimKeys: ['rowan_at_the_quay', 'ferryman_saw_it'] },
        },
        {
          key: 'trust_rowan_timing', label: 'Give the token back. “You decide when he is safe enough.”',
          intent: 'Place witness safety in Rowan\'s hands, accepting the cost of delay.', flag: 'rowan_timing_trusted',
          response: 'His fingers close over yours with the token between them. “That is more trust than I have earned.” He does not release your hand immediately. “I intend to earn it before you regret the expense.”',
          crisisResponse: '“One night,” he says. “If I cannot make him safe by dawn, we go to Veranne anyway.” His forehead touches yours, a promise made without spectacle. “Hold me to that.”',
          aftermath: 'Rowan keeps control of the witness plan. Your trust deepens the bond, while public suspicion persists longer.',
          impression: 'The outsider trusted Rowan to choose the moment that would keep Caleb alive.',
          effects: { trust: 650, affinity: 650, respect: 250, globalTension: 100, revealClaimKeys: ['rowan_at_the_quay', 'ferryman_saw_it'] },
        },
        {
          key: 'clear_name_now', label: '“Use Caleb now. Your name cannot survive another day of this.”',
          intent: 'Prioritize Rowan\'s reputation over the witness\'s readiness.', flag: 'rowan_reputation_over_witness',
          response: '“My name has survived centuries of men doing worse than being misunderstood.” He takes back the token. “Caleb has only one life. I had hoped you understood the difference.”',
          crisisResponse: 'Rowan\'s expression empties. “If I become innocent by making him a target, then your innocence and mine are different things.”',
          aftermath: 'Rowan refuses. The rumor remains hot, and he questions whether your care is for him or for the version of him the town might approve.',
          impression: 'The outsider valued clearing Rowan’s name above the safety of the witness who could clear it.',
          effects: { trust: -450, affinity: -350, respect: -300, reputation: 150, rumorHeat: { claimKey: 'rowan_at_the_quay', amount: 350 }, revealClaimKeys: ['rowan_at_the_quay', 'ferryman_saw_it'], status: 'strained' },
        },
      ],
    },
    {
      key: 'rowan_horse_path', chapter: 3, title: 'The Long Way Home',
      kicker: 'A man allowed to need', minimum: { trust: 5450, affinity: 500, respect: 300 },
      narration: 'Rowan takes the long path home, the one that climbs above the mill and leaves the town briefly hidden. He says the horse needs the gentler grade. There is no horse with him.',
      crisisNarration: 'The direct road is watched, so Rowan leads you along the ridge above the dark fields. Even here the town\'s fires are visible, but distance makes them small enough to survive looking at.',
      opening: '“I used to come here after my mother died.” He keeps his eyes on the path. “No one followed because I said I wanted to be alone. I did not. I simply did not know the words for the other thing.”',
      crisisOpening: '“Stay,” Rowan says. The word lands with the effort of a confession. “I know that is not a complete sentence. It is the complete truth.”',
      callbacks: [
        { flag: 'rowan_silence_challenged_gently', text: 'He is trying to answer the question you never forced: what his silence has been doing to him.' },
        { flag: 'rowan_timing_trusted', text: 'The trust you placed in his timing has made this request possible. He is learning that asking is not the same as taking.' },
      ],
      choices: [
        {
          key: 'stay_and_name_need', label: '“I will stay. Next time, you may tell me you need me.”',
          intent: 'Meet the need while challenging him to speak it without shame.', flag: 'rowan_need_welcomed',
          response: 'He nods, then stops walking. “I need you.” The words are rough from disuse. His laugh comes suddenly, bright and disbelieving. “That was appalling. I would like to try it again someday.”',
          crisisResponse: '“I need you,” he says at once, as if the town may take the chance if he hesitates. His hand finds yours. “Not to save me. Not to agree. To be here and remain yourself.”',
          aftermath: 'Rowan practices asking for closeness instead of arranging circumstances that force you to infer it.',
          impression: 'The outsider welcomed Rowan’s need and asked him to speak it without shame.',
          effects: { trust: 650, affinity: 750, respect: 550, status: 'growing' },
        },
        {
          key: 'stay_without_words', label: 'Walk beside him and let the unfinished sentence be enough.',
          intent: 'Offer intuitive comfort without asking him to grow past indirectness yet.', flag: 'rowan_unspoken_need_met',
          response: 'Your sleeves brush as the path narrows. After several minutes he says, “You are very good at hearing what I fail to say.” Affection warms the words; worry follows. “I must not make that your permanent labor.”',
          crisisResponse: 'He laces his fingers with yours in the dark. No vow follows. The silence is not empty, but both of you can feel how much it asks you to carry.',
          aftermath: 'The closeness is deep and real. Rowan also recognizes that being understood cannot excuse never communicating.',
          impression: 'The outsider heard Rowan’s unspoken need; he was comforted and aware that silence cannot always be their language.',
          effects: { trust: 550, affinity: 700, respect: 250, status: 'growing' },
        },
        {
          key: 'praise_solitude', label: '“You have always been strong enough to carry this alone.”',
          intent: 'Mistake endurance for the identity Rowan wants affirmed.', flag: 'rowan_martyrdom_praised',
          response: 'He looks at you then, disappointment plain. “Yes,” he says. “That is the problem.” The walk back is shorter because he takes the direct road.',
          crisisResponse: '“I am telling you I do not want to.” His voice cracks on the last word. He turns away before either of you can pretend not to hear it.',
          aftermath: 'Rowan feels returned to the lonely role he was trying to set down.',
          impression: 'The outsider praised Rowan’s isolation when he was asking permission not to endure alone.',
          effects: { trust: -250, affinity: -450, respect: 100, status: 'strained' },
        },
      ],
    },
    {
      key: 'rowan_open_gate', chapter: 4, title: 'The Gate Left Open',
      kicker: 'Honor after silence', minimum: { trust: 5650, affinity: 850, respect: 500 },
      narration: 'Rowan has written a statement that confirms the quay sighting and names Caleb as a witness. Signing it could clear Rowan and endanger Caleb; withholding it could let the Corvane rumor pull the town toward war.',
      crisisNarration: 'Corvane riders are saddling in the courtyard. Rowan can stop them only by admitting where he was and why his father\'s story is incomplete. The gate stands open behind him.',
      opening: '“My father calls silence loyalty. I called it protection. I think we were both choosing the word that let us sleep.” He offers you the unsigned page. “If I testify, I need Caleb beside me or already beyond their reach.”',
      crisisOpening: '“If I walk through that gate, I may cease to be Corvane in every way that matters to my father.” Rowan looks at you. “Do not tell me titles are meaningless. Tell me what remains when one is taken.”',
      callbacks: [
        { flag: 'rowan_witness_protected_for_truth', text: 'You already built a plan in which safety and truth could coexist. Now Rowan must decide whether to stand publicly inside it.' },
        { flag: 'rowan_reputation_over_witness', text: 'Your earlier willingness to risk Caleb has not been forgotten. The right answer now will require action, not reassurance.' },
      ],
      choices: [
        {
          key: 'testify_together', label: '“We move Caleb first. Then I stand beside you while you testify.”',
          intent: 'Make truth a shared action with concrete protection.', flag: 'rowan_public_truth_shared',
          response: 'Rowan signs. The scratch of the pen sounds louder than the courtyard. “Beside me,” he repeats. “Not behind, not speaking for me.” His hand trembles once before you take it. “Yes. That is how I can do this.”',
          crisisResponse: 'He signs against the gatepost. “Then whatever remains is the part of me that chose.” He presses the statement into your hand and calls for Caleb\'s escort. The riders begin to unsaddle.',
          aftermath: 'Rowan\'s protected testimony cools Corvane retaliation and strengthens the true witness thread.',
          impression: 'The outsider stood beside Rowan as he chose public truth without sacrificing Caleb to it.',
          effects: { trust: 750, affinity: 600, respect: 850, reputation: -150, globalTension: -600, factionTension: -650, rumorHeat: { claimKey: 'rowan_at_the_quay', amount: -1000 }, revealClaimKeys: ['rowan_at_the_quay', 'ferryman_saw_it'], negotiation: true, status: 'growing' },
        },
        {
          key: 'send_caleb_away', label: '“Send Caleb away. Take the suspicion and deny them their witness.”',
          intent: 'Preserve the vulnerable person at the cost of truth and Rowan\'s standing.', flag: 'rowan_chose_witness_over_name',
          response: '“That was my first plan.” He looks at the road beyond the gate. “It may still be the kindest one.” Then, more quietly: “If I become a man the town hates, will you tell me when I begin using that hatred as an excuse?”',
          crisisResponse: 'Rowan tears the statement in half. “Then he lives, and I carry the rest.” He turns to you with exhausted honesty. “Do not admire me for this. Help me find a better answer after tonight.”',
          aftermath: 'Caleb is protected, but the investigation loses immediate testimony and suspicion around Rowan intensifies.',
          impression: 'The outsider helped Rowan protect Caleb at grave cost, while refusing to romanticize martyrdom.',
          effects: { trust: 650, affinity: 750, respect: 350, reputation: -450, globalTension: 300, rumorHeat: { claimKey: 'rowan_at_the_quay', amount: 700 }, revealClaimKeys: ['rowan_at_the_quay', 'ferryman_saw_it'], status: 'complicated' },
        },
        {
          key: 'obey_alric', label: '“Stay. Your father and your house need you more than the truth does.”',
          intent: 'Ask Rowan to preserve Corvane unity by returning to the silence he is trying to outgrow.', flag: 'rowan_returned_to_father',
          response: 'Rowan folds the statement with exact care. “My father would call that love.” He gives it back unsigned. “I had begun to hope ours might ask something different of me.”',
          crisisResponse: 'The open gate closes between you with one push of his hand. “Then you do not love me,” he says without cruelty. “You love the version of me that never makes anyone choose.”',
          aftermath: 'Rowan remains inside Corvane discipline. The house hardens, and the relationship fractures around the choice.',
          impression: 'The outsider asked Rowan to preserve Corvane obedience at the cost of truth and growth.',
          effects: { trust: -750, affinity: -700, respect: -500, reputation: 500, globalTension: 450, factionTension: 350, status: 'strained' },
        },
      ],
    },
    {
      key: 'rowan_river_stones', chapter: 5, title: 'Stones Beneath the River',
      kicker: 'No performance, no possession', minimum: { trust: 5950, affinity: 1200, respect: 650 },
      narration: 'Rowan leads you to a narrow place where the river runs clear over dark stones. He has brought bread, two apples, and no plausible excuse for why this meeting is necessary.',
      crisisNarration: 'The river reflects fire from the town, but the stones beneath remain visible. Rowan has brought nothing except the truth he has rehearsed and failed to say three times.',
      opening: '“I know how to offer a horse, a coat, or a public oath.” He looks genuinely annoyed with himself. “I do not know how to offer my heart without making it sound like another object I expect you to keep safe.”',
      crisisOpening: '“I love you.” Rowan says it before fear can improve the wording. “You are not obliged to make that useful. I needed one truth tonight that harmed no witness by being spoken.”',
      callbacks: [
        { flag: 'rowan_need_welcomed', text: 'He has practiced the language you asked for. The directness is not natural yet; it is chosen.' },
        { flag: 'rowan_martyrdom_praised', text: 'He is risking another attempt to be known as someone who needs, not merely someone who endures.' },
      ],
      choices: [
        {
          key: 'kiss_rowan', label: '“You are not an object. You are a choice I am making.” Ask, and kiss him.',
          intent: 'Answer with explicit, mutual romantic desire.', flag: 'rowan_first_kiss',
          response: '“Yes,” he says, startled by how much the asking matters. His hand comes to your jaw with almost reverent care. The kiss is warm, then laughing when the apple rolls into the river. “I had hoped to be more dignified.” “I had not,” he admits.',
          crisisResponse: 'His yes breaks on a breath. He kisses you slowly despite every urgent sound behind you, one hand at the back of your neck. When you part, he says, “Good. The world did not become less terrible. It became larger than terror.”',
          aftermath: 'You and Rowan begin a chosen romance that asks neither person to become proof of the other\'s worth.',
          impression: 'Rowan and the outsider chose a mutual romance grounded in consent, directness, and separate personhood.',
          effects: { trust: 750, affinity: 1000, respect: 650, status: 'courting' },
        },
        {
          key: 'answer_not_yet', label: '“What I feel is real. I am not ready to promise its shape.”',
          intent: 'Acknowledge intimacy without giving a certainty you do not have.', flag: 'rowan_honest_uncertainty',
          response: 'Rowan nods slowly. “Then I will not make waiting into a test you can fail.” He offers you half the bread. “May I still sit close enough that our shoulders touch?”',
          crisisResponse: 'Pain flickers, followed by resolve. “Real is enough for tonight.” He takes your hand only after you open it. “No borrowed certainty. I have had enough of borrowed things.”',
          aftermath: 'The bond remains tender and undefined. Rowan respects uncertainty that is spoken instead of hidden.',
          impression: 'The outsider answered Rowan’s love with honest uncertainty rather than a comforting false promise.',
          effects: { trust: 750, affinity: 650, respect: 800, status: 'complicated' },
        },
        {
          key: 'choose_rowan_friendship', label: '“I love you as my friend. I will not disguise that as less.”',
          intent: 'Decline courtship while honoring the depth of friendship.', flag: 'rowan_chosen_friendship',
          response: 'He looks at the river until disappointment passes cleanly through him. “Do not call it less,” he says. “You are right.” He hands you the better apple. “I may be awkward for a few days. I would prefer to be awkward nearby.”',
          crisisResponse: 'Rowan closes his eyes. “Then stay my friend and survive long enough for this to become a story we tell badly.” His embrace is strong, brief, and without persuasion.',
          aftermath: 'Rowan accepts a lasting friendship without bargaining, punishment, or a romantic lockout affecting the other route.',
          impression: 'The outsider chose honest friendship with Rowan, and he kept it without turning hurt into a debt.',
          effects: { trust: 850, affinity: 250, respect: 850, status: 'platonic' },
        },
      ],
    },
    {
      key: 'rowan_bridge_at_low_water', chapter: 6, title: 'The Bridge at Low Water',
      kicker: 'What remains and what is chosen', minimum: { trust: 6250, affinity: 1450, respect: 850 },
      narration: 'At low water, the old footbridge reveals names cut into its underside by generations who expected the river to keep their secrets. Rowan holds a knife, then offers it to you handle-first.',
      crisisNarration: 'Half the bridge is gone, but the oldest beam remains above the low river. Rowan finds an unburned place beneath it and offers you the knife handle-first.',
      opening: '“Corvanes carve names into stone because we want permanence to look obedient.” He touches the weathered beam. “Wood changes shape and remains itself. I thought we might choose something wiser than stone.”',
      crisisOpening: '“No oath against change,” he says. “No promise that fear will never make us foolish. Only a mark that says we were here, and we chose what came next.”',
      callbacks: [
        { flag: 'rowan_first_kiss', text: 'The memory of the riverbank has made Rowan less afraid of joy looking undignified.' },
        { flag: 'rowan_chosen_friendship', text: 'He offers the knife without romantic expectation. Friendship is not a waiting room in his version of the future.' },
        { flag: 'rowan_chose_witness_over_name', text: 'His sacrifice for Caleb remains morally unfinished. A future with him will include challenging the part that still mistakes self-erasure for goodness.' },
      ],
      choices: [
        {
          key: 'carve_shared_mark', label: 'Carve two lines meeting, not two names becoming one.',
          intent: 'Commit to a shared future that preserves two identities.', flag: 'rowan_committed_future',
          response: 'Rowan studies the mark and smiles with his whole face. “Meeting,” he says. “Not merging. Not trapping.” He kisses the wood dust from your thumb. “I can promise to keep choosing the crossing.”',
          crisisResponse: 'The knife shakes once between your hands, then cuts true. Rowan presses his forehead to yours. “Whatever survives us will know we did not face it alone.”',
          aftermath: 'You commit to a life with Rowan based on repeated choice rather than ownership or inherited duty.',
          impression: 'Rowan and the outsider committed to keep meeting as two whole people through whatever changes.',
          effects: { trust: 950, affinity: 1200, respect: 900, globalTension: -250, factionTension: -400, negotiation: true, status: 'committed' },
        },
        {
          key: 'leave_bridge_uncarved', label: 'Return the knife. “Let the promise live in what we do.”',
          intent: 'Choose commitment without a permanent symbol.', flag: 'rowan_living_promise',
          response: 'He slips the knife away. “Good. I was afraid the carving might be too theatrical.” A pause. “I was also desperately hoping you would agree to it.” Your laughter follows him into a kiss. “Actions, then. Beginning with honesty about bad ideas.”',
          crisisResponse: '“Then this is the mark.” He takes your hand. “Leaving together. Returning when we can. No river required to remember for us.”',
          aftermath: 'The relationship is committed through practice rather than inscription, exactly the kind of promise Rowan most needs to learn.',
          impression: 'Rowan and the outsider chose a living commitment proved through action, not permanence performed for others.',
          effects: { trust: 1000, affinity: 900, respect: 1000, negotiation: true, status: 'committed' },
        },
        {
          key: 'mark_friendship', label: 'Carve a small open gate. “For the truth we leave each other free to enter.”',
          intent: 'Seal an enduring platonic or complicated bond without romantic possession.', flag: 'rowan_beloved_ally',
          response: 'Rowan traces the open shape. “A gate that does not close behind either person.” He nods. “That is a promise I know how to keep.” His shoulder settles against yours as the river rises by degrees.',
          crisisResponse: '“Open,” he says, touching the mark. “Even now.” He embraces you with no hidden request. “If I begin building walls and calling them protection, come through this gate and tell me.”',
          aftermath: 'You become enduring chosen family, with the freedom to challenge Rowan and influence Corvane without romantic obligation.',
          impression: 'Rowan and the outsider chose an enduring bond with an open gate instead of ownership.',
          effects: { trust: 1050, affinity: 350, respect: 1150, globalTension: -200, factionTension: -300, negotiation: true, status: 'platonic' },
        },
      ],
    },
  ],
  epilogues: {
    peace: {
      committed: 'Rowan helps dismantle the Corvane checkpoints and rebuilds the low-water bridge. The mark beneath it remains private; the life you make from it does not.',
      platonic: 'Rowan becomes a witness advocate instead of the heir his father planned. Your friendship is the open gate in his life: never possession, never silence mistaken for care.',
      default: 'Peace gives Rowan time to learn that survival is not the same as solitude. He asks you to walk the long road again, this time without inventing a horse.',
    },
    exposed: {
      committed: 'With the culprit exposed, Rowan testifies to every truth his house tried to simplify. Afterward he meets you by the river, where the future is no longer an alibi either of you must prove.',
      platonic: 'Rowan uses the exposure to protect witnesses who would otherwise become footnotes. You remain the friend who challenges every noble silence before it can call itself honor.',
      default: 'The truth clears Rowan without making his secrecy harmless. He comes to you with an apology, an apple, and the beginning of a more direct sentence.',
    },
    war: {
      committed: 'Rowan abandons the Corvane inheritance to escort civilians through the fields. The bridge is lost; the promise is not. He keeps meeting you wherever the road permits.',
      platonic: 'Rowan turns his talent for quiet routes toward getting families out alive. Your friendship keeps his courage from hardening into another form of martyrdom.',
      default: 'War proves that silence cannot shelter everyone. Rowan carries what he failed to say, but also the knowledge that the path between you remains open if both survive it.',
    },
    expired: { default: 'Time closes around the unresolved murder. Rowan does not demand certainty from you; he asks for one more walk and tries, carefully, to say why.' },
    unfinished: { default: 'Rowan is still deciding whether being known by you is more frightening than remaining misunderstood by everyone else.' },
  },
};

export const ROMANCE_CANDIDATES: Readonly<Record<RomanceAgentKey, RomanceCandidateDef>> = {
  maren_aldreth: MAREN,
  rowan_corvane: ROWAN,
};

export function romanceCandidate(agentKey: string): RomanceCandidateDef | null {
  return ROMANCE_CANDIDATES[agentKey as RomanceAgentKey] ?? null;
}

export function isCrisisStage(stage: string): boolean {
  return ['accusations', 'trials', 'first_blood', 'war'].includes(stage);
}

export function romanceStatusAfterChoice(
  previous: RomanceStatus,
  choice: RomanceChoiceDef,
  nextChapter: number,
): RomanceStatus {
  if (choice.effects.status) return choice.effects.status;
  if (previous === 'committed' || previous === 'platonic') return previous;
  if (nextChapter >= 1 && previous === 'open') return 'growing';
  return previous;
}

export function epilogueFor(
  candidate: RomanceCandidateDef,
  ending: string | null,
  status: RomanceStatus,
): string {
  const endingKey = ending && ending in candidate.epilogues
    ? ending as keyof RomanceCandidateDef['epilogues']
    : ending ? 'expired' : 'unfinished';
  const group = candidate.epilogues[endingKey];
  return group[status] ?? group.default ?? candidate.epilogues.unfinished.default!;
}
