#![cfg_attr(not(test), no_std)]
#![allow(unused_imports)]

//! SluiceRegistry — an on-chain anchor for the Sluice streaming x402 economy.
//!
//! The streaming meter runs off-chain (per-second settlement is via x402 `transfer_with_authorization`),
//! but the *terms* of each stream and a tamper-evident *checkpoint* of its cumulative settlement totals
//! are recorded here on Casper. This makes the public /impact proof feed verifiable against on-chain
//! state — anyone can read the registry and confirm the numbers, with no trust in the Sluice server.
//!
//! Entry points (owner-gated writes):
//!   - register_stream(stream_id, provider, rate_per_second)
//!   - checkpoint(stream_id, settlements, total_paid, seconds_streamed)
//! Reads are public getters.

use odra::prelude::*;
use odra::casper_types::U256;

/// One stream's on-chain record: its provider, price, and latest settlement checkpoint.
#[odra::odra_type]
pub struct StreamRecord {
    pub provider: String,
    pub rate_per_second: U256,
    pub settlements: u64,
    pub total_paid: U256,
    pub seconds_streamed: u64,
}

#[odra::module]
pub struct SluiceRegistry {
    owner: Var<Address>,
    stream_count: Var<u32>,
    streams: Mapping<String, StreamRecord>,
}

#[odra::module]
impl SluiceRegistry {
    /// Deploy-time init: record the deployer as the only account allowed to write.
    pub fn init(&mut self) {
        self.owner.set(self.env().caller());
        self.stream_count.set(0);
    }

    /// Register or update a stream's terms (provider + per-second rate).
    pub fn register_stream(&mut self, stream_id: String, provider: String, rate_per_second: U256) {
        self.assert_owner();
        let existing = self.streams.get(&stream_id);
        if existing.is_none() {
            let c = self.stream_count.get_or_default();
            self.stream_count.set(c + 1);
        }
        let rec = existing.unwrap_or(StreamRecord {
            provider: provider.clone(),
            rate_per_second,
            settlements: 0,
            total_paid: U256::zero(),
            seconds_streamed: 0,
        });
        self.streams.set(
            &stream_id,
            StreamRecord { provider, rate_per_second, ..rec },
        );
    }

    /// Anchor the latest cumulative settlement totals for a stream.
    pub fn checkpoint(
        &mut self,
        stream_id: String,
        settlements: u64,
        total_paid: U256,
        seconds_streamed: u64,
    ) {
        self.assert_owner();
        let rec = self.streams.get(&stream_id).unwrap_or_revert_with(&self.env(), Error::UnknownStream);
        self.streams.set(
            &stream_id,
            StreamRecord { settlements, total_paid, seconds_streamed, ..rec },
        );
    }

    pub fn stream_count(&self) -> u32 {
        self.stream_count.get_or_default()
    }

    pub fn get_stream(&self, stream_id: String) -> Option<StreamRecord> {
        self.streams.get(&stream_id)
    }

    pub fn get_settlements(&self, stream_id: String) -> u64 {
        self.streams.get(&stream_id).map(|r| r.settlements).unwrap_or_default()
    }

    pub fn get_total_paid(&self, stream_id: String) -> U256 {
        self.streams.get(&stream_id).map(|r| r.total_paid).unwrap_or_default()
    }

    fn assert_owner(&self) {
        let caller = self.env().caller();
        if Some(caller) != self.owner.get() {
            self.env().revert(Error::NotOwner);
        }
    }
}

#[odra::odra_error]
pub enum Error {
    NotOwner = 1,
    UnknownStream = 2,
}
