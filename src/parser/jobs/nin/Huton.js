import {Trans, Plural} from '@lingui/react'
import React, {Fragment} from 'react'
import {Icon, Message} from 'semantic-ui-react'

import {ActionLink} from 'components/ui/DbLink'
import ACTIONS from 'data/ACTIONS'
import BOSSES from 'data/BOSSES'
import Module from 'parser/core/Module'
import {Rule, Requirement} from 'parser/core/modules/Checklist'
import {Suggestion, TieredSuggestion, SEVERITY} from 'parser/core/modules/Suggestions'
import DISPLAY_ORDER from './DISPLAY_ORDER'

const HUTON_MAX_DURATION_MILLIS = 70000 // Not in STATUSES/NIN.js because lolgauges
const HUTON_START_DURATION_MILLIS = {
	high: 65000,
	low: 59000,
}
const ARMOR_CRUSH_EXTENSION_MILLIS = 30000

const DOWNTIME_DIFFERENCE_TOLERANCE = 10000 // If the downtime estimates are off by more than this, we can probably toss the low estimate

// Some bosses *coughChadarnookcough* require fucky pulls that result in your Huton timer being lower than normal when the fight starts
const BOSS_ADJUSTMENTS = {
	[BOSSES.DEMON_CHADARNOOK.logId]: 15000,
}

export default class Huton extends Module {
	static handle = 'huton'
	static dependencies = [
		'checklist',
		'death',
		'suggestions',
	]

	_currentDuration = {
		high: HUTON_START_DURATION_MILLIS.high - (BOSS_ADJUSTMENTS[this.parser.fight.boss] || 0),
		low: HUTON_START_DURATION_MILLIS.low - (BOSS_ADJUSTMENTS[this.parser.fight.boss] || 0),
	}
	_clippedDuration = {
		high: 0,
		low: 0,
	}
	_downtime = {
		high: 0,
		low: 0,
	}
	_futileArmorCrushes = {
		high: 0,
		low: 0,
	}
	_lastEventTime = this.parser.fight.start_time // This one is shared

	constructor(...args) {
		super(...args)
		this.addHook('cast', {by: 'player', abilityId: ACTIONS.HUTON.id}, this._onHutonCast)
		this.addHook('combo', {by: 'player', abilityId: ACTIONS.ARMOR_CRUSH.id}, this._onArmorCrush)
		this.addHook('death', {to: 'player'}, this._onDeath)
		this.addHook('raise', {to: 'player'}, this._onRaise)
		this.addHook('complete', this._onComplete)
	}

	_handleHutonRecast(key, elapsedTime) {
		if (this._currentDuration[key] === 0) {
			this._downtime[key] += elapsedTime
		}

		this._currentDuration[key] = HUTON_MAX_DURATION_MILLIS
	}

	_onHutonCast(event) {
		const elapsedTime = (event.timestamp - this._lastEventTime)
		this._handleHutonRecast('high', elapsedTime)
		this._handleHutonRecast('low', elapsedTime)
		this._lastEventTime = event.timestamp
	}

	_handleArmorCrush(key, elapsedTime) {
		let newDuration = this._currentDuration[key] - elapsedTime
		if (newDuration <= 0) {
			this._currentDuration[key] = 0
			this._downtime[key] -= newDuration // Since it's negative, this is basically addition
			this._futileArmorCrushes[key]++
		} else {
			newDuration += ARMOR_CRUSH_EXTENSION_MILLIS
			this._clippedDuration[key] += Math.max(newDuration - HUTON_MAX_DURATION_MILLIS, 0)
			this._currentDuration[key] = Math.min(newDuration, HUTON_MAX_DURATION_MILLIS)
		}
	}

	_onArmorCrush(event) {
		const elapsedTime = (event.timestamp - this._lastEventTime)
		this._handleArmorCrush('high', elapsedTime)
		this._handleArmorCrush('low', elapsedTime)
		this._lastEventTime = event.timestamp
	}

	_onDeath() {
		// RIP
		this._currentDuration.high = 0
		this._currentDuration.low = 0
	}

	_onRaise(event) {
		// So floor time doesn't count against Huton uptime
		this._lastEventTime = event.timestamp
	}

	_getHutonAverages() {
		if (this._downtime.low - this._downtime.high > DOWNTIME_DIFFERENCE_TOLERANCE) {
			// If the estimates are too far apart, the low one was probably bad, so we can just return the high one as-is
			return {
				clippedDuration: this._clippedDuration.high,
				downtime: this._downtime.high,
				futileArmorCrushes: this._futileArmorCrushes.high,
				averaged: false,
			}
		}

		// Otherwise, average the results
		return {
			clippedDuration: Math.round((this._clippedDuration.high + this._clippedDuration.low) / 2),
			downtime: Math.round((this._downtime.high + this._downtime.low) / 2),
			futileArmorCrushes: Math.round((this._futileArmorCrushes.high + this._futileArmorCrushes.low) / 2),
			averaged: true,
		}
	}

	_onComplete() {
		const {clippedDuration, downtime, futileArmorCrushes/*, averaged*/} = this._getHutonAverages()
		const duration = this.parser.fightDuration - this.death.deadTime
		const uptime = ((duration - downtime) / duration) * 100
		this.checklist.add(new Rule({
			name: <Trans id="nin.huton.checklist.name">Keep Huton up</Trans>,
			description: <Fragment>
				<Trans id="nin.huton.checklist.description"><ActionLink {...ACTIONS.HUTON}/> provides you with a 15% attack speed increase and as such is a <em>huge</em> part of a NIN's personal DPS. Do your best not to let it drop, and recover it as quickly as possible if it does.</Trans>
				<Message warning icon>
					<Icon name="warning sign"/>
					<Message.Content>
						<Trans id="nin.huton.checklist.description.warning">As Huton is now a gauge instead of a buff, please bear in mind that this is an estimate, not an exact value. This also applies to any Huton-related suggestions below.</Trans>
					</Message.Content>
				</Message>
			</Fragment>,
			displayOrder: DISPLAY_ORDER.HUTON,
			requirements: [
				new Requirement({
					name: <Trans id="nin.huton.checklist.requirement.name"><ActionLink {...ACTIONS.HUTON}/> uptime</Trans>,
					percent: () => uptime,
				}),
			],
			target: 99,
		}))

		if (clippedDuration > 0) {
			this.suggestions.add(new TieredSuggestion({
				icon: ACTIONS.HUTON.icon,
				content: <Trans id="nin.huton.suggestions.clipping.content">
					Avoid using <ActionLink {...ACTIONS.ARMOR_CRUSH}/> when <ActionLink {...ACTIONS.HUTON}/> has more than 40 seconds left on its duration. The excess time is wasted, so your other two combo finishers are typically better options.
				</Trans>,
				tiers: {
					5000: SEVERITY.MINOR,
					10000: SEVERITY.MEDIUM,
					20000: SEVERITY.MAJOR,
				},
				value: clippedDuration,
				why: <Trans id="nin.huton.suggestions.clipping.why">
					You clipped {this.parser.formatDuration(clippedDuration)} of Huton with early Armor Crushes.
				</Trans>,
			}))
		}

		if (futileArmorCrushes > 0) {
			this.suggestions.add(new Suggestion({
				icon: ACTIONS.ARMOR_CRUSH.icon,
				content: <Trans id="nin.huton.suggestions.futile-ac.content">
					Avoid using <ActionLink {...ACTIONS.ARMOR_CRUSH}/> when <ActionLink {...ACTIONS.HUTON}/> is down, as it provides no benefit and does less DPS than your other combo finishers.
				</Trans>,
				severity: SEVERITY.MEDIUM,
				why: <Trans id="nin.huton.suggestions.futile-ac.why">
					You used Armor Crush <Plural value={futileArmorCrushes} one="# time" other="# times"/> when Huton was down.
				</Trans>,
			}))
		}
	}
}
