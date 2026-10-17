//! MonoCode activity collector: the logic, kept free of macOS calls so it
//! builds and is tested on any host. Detection only: nothing here blocks.

pub mod event;
pub mod filter;
pub mod lines;
pub mod log;
pub mod retention;
pub mod timefmt;
pub mod tree;
