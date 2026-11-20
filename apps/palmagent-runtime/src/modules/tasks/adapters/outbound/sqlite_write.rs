//! Join the selected owner's transaction when several Task effects commit together.
use rusqlite::{Connection, Result, Savepoint, Transaction, TransactionBehavior};
use std::ops::Deref;

pub(super) enum Write<'a> {
    Outer(Transaction<'a>),
    Nested(Savepoint<'a>),
}
impl<'a> Write<'a> {
    pub fn begin(db: &'a mut Connection) -> Result<Self> {
        if db.is_autocommit() {
            Ok(Self::Outer(db.transaction_with_behavior(
                TransactionBehavior::Immediate,
            )?))
        } else {
            Ok(Self::Nested(db.savepoint()?))
        }
    }
    pub fn commit(self) -> Result<()> {
        match self {
            Self::Outer(tx) => tx.commit(),
            Self::Nested(tx) => tx.commit(),
        }
    }
}
impl Deref for Write<'_> {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        match self {
            Self::Outer(tx) => tx,
            Self::Nested(tx) => tx,
        }
    }
}
