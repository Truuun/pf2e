import { type ActorPF2e, ActorProxyPF2e } from "@actor";
import { type ItemPF2e, ItemProxyPF2e } from "@item";
import {
    AuraRuleElement,
    AuraRuleElementTextureSchema,
    type AuraRuleElementSchema,
} from "@module/rules/rule-element/aura.ts";
import { RuleElementForm, RuleElementFormSheetData, RuleElementFormTabData } from "./base.ts";
import { htmlClosest, htmlQuery, htmlQueryAll, isImageFilePath, tagify } from "@util";
import * as R from "remeda";

class AuraForm extends RuleElementForm<AuraRuleElementSource, AuraRuleElement> {
    override template = "systems/pf2e/templates/items/rules/aura.hbs";
    protected override tabs: RuleElementFormTabData = {
        names: ["basic", "effects", "appearance"],
        displayStyle: "grid",
    };

    #effectsMap: Map<number, AuraEffectSource> = new Map();

    get effectsArray(): AuraEffectSource[] {
        return [...this.#effectsMap.values()];
    }

    protected override getInitialValue(): object {
        const data = super.getInitialValue();

        // If this rule element is on an unowned item get full initial data by creating a fake actor
        if (!this.object) {
            const actor = new ActorProxyPF2e({ _id: randomID(), name: "temp", type: "character" });
            const item = new ItemProxyPF2e(this.item.toObject(), { parent: actor }) as ItemPF2e<ActorPF2e>;
            this.object = new AuraRuleElement(deepClone(this.rule), { parent: item, suppressWarnings: true });
        }

        this.#effectsMap.clear();
        this.#effectsMap = new Map(
            this.object.toObject().effects.map((e, index): [number, AuraEffectSource] => [index, e])
        );

        return data;
    }

    override activateListeners(html: HTMLElement): void {
        super.activateListeners(html);

        const traitsElement = htmlQuery<HTMLInputElement>(html, ".tagify-traits");
        if (traitsElement) {
            const whitelist = { ...CONFIG.PF2E.spellTraits, ...CONFIG.PF2E.actionTraits };
            tagify(traitsElement, { whitelist, enforceWhitelist: false });
        }

        for (const eventsElement of htmlQueryAll<HTMLInputElement>(html, ".tagify-events")) {
            const whitelist = [
                ["enter", game.i18n.localize("PF2E.RuleEditor.Aura.Effects.EventsOptions.Enter")],
                ["turn-start", game.i18n.localize("PF2E.RuleEditor.Aura.Effects.EventsOptions.TurnStart")],
                ["turn-end", game.i18n.localize("PF2E.RuleEditor.Aura.Effects.EventsOptions.TurnEnd")],
            ].sort((a, b) => a[1].localeCompare(b[1], game.i18n.lang));
            tagify(eventsElement, { whitelist: R.mapToObj(whitelist, (w) => [w[0], w[1]]), enforceWhitelist: true });
        }

        for (const element of htmlQueryAll(html, "a[data-action=remove-effect]")) {
            element.addEventListener("click", () => {
                this.#deleteEffect(element.dataset.effectId);
            });
        }

        for (const button of htmlQueryAll<HTMLButtonElement>(
            html,
            "div[data-rule-tab=effects] button[data-action=toggle-brackets]"
        )) {
            const fieldset = htmlClosest(button, "fieldset");
            const select = htmlQuery<HTMLSelectElement>(fieldset, "select");
            const input = htmlQuery<HTMLInputElement>(fieldset, "input");
            if (select && input && !select.value) {
                button.disabled = true;
                input.disabled = true;
            }
        }

        const translationX = htmlQuery<HTMLInputElement>(html, "input[data-translation=x]");
        const translationY = htmlQuery<HTMLInputElement>(html, "input[data-translation=y]");
        if (translationX && translationY) {
            translationX.addEventListener("change", () => {
                if (translationX.value !== "" && translationY.value === "") {
                    translationY.value = translationX.value;
                }
            });
            translationY.addEventListener("change", () => {
                if (translationY.value !== "" && translationX.value === "") {
                    translationX.value = translationY.value;
                }
            });
        }
    }

    override async getData(): Promise<AuraSheetData> {
        return {
            ...(await super.getData()),
            affectsOptions: {
                all: "PF2E.RuleEditor.Aura.Effects.AffectsOptions.All",
                allies: "PF2E.RuleEditor.Aura.Effects.AffectsOptions.Allies",
                enemies: "PF2E.RuleEditor.Aura.Effects.AffectsOptions.Enemies",
            },
            effects: this.effectsArray.map((e) => ({
                ...e,
                item: fromUuidSync(e.uuid),
            })),
            saveTypes: CONFIG.PF2E.saves,
            isImageFile: isImageFilePath(this.rule.appearance?.texture?.src),
        };
    }

    protected override async onDrop(event: DragEvent, element: HTMLElement): Promise<ItemPF2e | null> {
        const { id } = element.dataset;
        if (id !== "aura-effect-drop") return null;
        const item = await super.onDrop(event, element);
        if (!item?.isOfType("effect") || !this.schema) return null;
        this.#addEffect(item.uuid);

        return item;
    }

    override async updateItem(updates: Partial<AuraRuleElementSource> | Record<string, unknown>): Promise<void> {
        const expanded = expandObject<Partial<AuraRuleElementSource>>(updates);
        if (expanded.effects) {
            // Restore clobbered effects array and perform updates
            expanded.effects = this.#updateEffectsMap(expanded);
        }
        return super.updateItem(expanded);
    }

    override updateObject(source: AuraRuleElementSource & Record<string, unknown>): void {
        // Restore clobbered effects array and perform updates
        source.effects = this.#updateEffectsMap(source);

        // Clean up texture data
        const appearance: DeepPartial<AuraRuleElementSource["appearance"]> = source.appearance;
        const texture: Maybe<DeepPartial<SourceFromSchema<AuraRuleElementTextureSchema>>> = appearance?.texture;
        if (texture) {
            if (texture.translation) {
                const { x, y } = texture.translation;
                if (!x && !y) {
                    delete texture.translation;
                }
            }
            if (!texture.src) {
                delete appearance?.texture;
            } else if (
                texture.src &&
                texture.src !== this.rule.appearance?.texture?.src &&
                isImageFilePath(texture.src)
            ) {
                delete texture?.playbackRate;
                delete texture?.loop;
            }
        }

        super.updateObject(source);
    }

    #addEffect(uuid: ItemUUID): void {
        const index = this.#effectsMap.size + 1;
        this.#effectsMap.set(index, { uuid } as AuraEffectSource);
        this.updateItem({ effects: this.effectsArray });
    }

    #updateEffectsMap(source: AuraRuleElementSource | Partial<AuraRuleElementSource>): AuraEffectSource[] {
        type EffectObject = Record<string, Partial<AuraEffectSource & Record<string, null>>>;

        const effectData = duplicate(source.effects ?? null);
        if (R.isObject<Maybe<EffectObject>>(effectData)) {
            for (const [id, effectUpdate] of Object.entries(effectData)) {
                const index = Number(id);
                if (isNaN(index)) continue;
                const currentData = this.#effectsMap.get(index);
                if (!currentData) continue;

                // Clean up save data
                if (effectUpdate.save) {
                    const type = effectUpdate.save.type ?? currentData.save?.type;
                    if (type && !effectUpdate.save.dc) {
                        effectUpdate.save.dc = "";
                    } else if (!type) {
                        delete effectUpdate.save;
                        effectUpdate["-=save"] = null;
                    }
                }

                // Clean up booleans that have an undefined initial value
                if (effectUpdate.includesSelf === true) {
                    delete effectUpdate.includesSelf;
                    effectUpdate["-=includesSelf"] = null;
                }
                if (effectUpdate.removeOnExit === true) {
                    delete effectUpdate.removeOnExit;
                    effectUpdate["-=removeOnExit"] = null;
                }

                mergeObject(currentData, effectUpdate, { performDeletions: true });
            }
        }
        return this.effectsArray;
    }

    #deleteEffect(id?: string): void {
        const index = Number(id);
        if (isNaN(index)) return;
        if (this.#effectsMap.delete(index)) {
            this.updateItem({ effects: this.effectsArray });
        }
    }
}

interface AuraSheetData extends RuleElementFormSheetData<AuraRuleElementSource, AuraRuleElement> {
    affectsOptions: Record<string, string>;
    effects: AuraRuleElementSource["effects"] &
        {
            item: ClientDocument | CompendiumIndexData | null;
        }[];
    saveTypes: ConfigPF2e["PF2E"]["saves"];
    isImageFile: boolean;
}

type AuraEffectSource = AuraRuleElementSource["effects"][number];

type AuraRuleElementSource = SourceFromSchema<AuraRuleElementSchema>;

export { AuraForm };
