use good_lp::{
    Expression, IntoAffineExpression, ProblemVariables, Solution, SolverModel, Variable,
    VariableDefinition, constraint, highs,
};

use serde::{Deserialize, Serialize};
use std::ffi::CString;
use std::os::raw::c_char;
use std::{slice, vec};

#[derive(Deserialize)]
pub struct VariableDef {
    pub name: String,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub initial: Option<f64>,
    pub integer: bool,
}
impl From<&VariableDef> for VariableDefinition {
    fn from(value: &VariableDef) -> Self {
        let mut res = Self::new().name(value.name.clone());
        if let Some(min) = value.min {
            res = res.min(min);
        }
        if let Some(max) = value.max {
            res = res.max(max);
        }
        if let Some(initial) = value.initial {
            res = res.initial(initial);
        }
        if value.integer {
            res = res.integer();
        }
        res
    }
}

#[derive(Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Min,
    Max,
}
#[derive(Deserialize)]
pub struct CoeffVar {
    pub name: String,
    pub factor: f64,
}
#[derive(Deserialize)]
pub struct MessageProblem {
    pub direction: Direction,
    pub variables: Vec<VariableDef>,
    pub objective: Vec<CoeffVar>,
    pub objective_offset: f64,

    pub constraints: Vec<Vec<CoeffVar>>, // <= 0 constraints
    pub constraint_offsets: Vec<f64>,

    pub equalities: Vec<Vec<CoeffVar>>, // == 0 constraints
    pub equalities_offsets: Vec<f64>,
}

#[derive(Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Optimal,
    Unbounded,
    Infeasible,
}
#[derive(Serialize)]
pub struct MessageSolution {
    pub status: Status,
    pub values: Vec<f64>,
}
impl MessageSolution {
    fn unbounded() -> Self {
        MessageSolution {
            status: Status::Unbounded,
            values: vec![],
        }
    }
    fn infeasible() -> Self {
        MessageSolution {
            status: Status::Infeasible,
            values: vec![],
        }
    }
    fn optimal(values: Vec<f64>) -> Self {
        MessageSolution {
            status: Status::Optimal,
            values,
        }
    }
}

/// Receives a byte buffer of a JSON-encoded MILP problem instance, computes a
/// solution, encodes it as JSON, and returns it as a C string.
///
/// A null pointer is returend if there is an error. The error message is
/// written to stderr.
///
/// # Safety
/// This function must be called with a valid length and byte buffer. See
/// [`slice::from_raw_parts`] for details.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn solve(buffer: *const u8, len: usize) -> *const c_char {
    if buffer.is_null() {
        return std::ptr::null();
    }
    let input_bytes = unsafe { slice::from_raw_parts(buffer, len) };
    let input: MessageProblem = match serde_json::from_slice(input_bytes) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("Error parsing JSON: {e}");
            return std::ptr::null();
        }
    };

    let mut problem = ProblemVariables::new();
    let vars: Vec<_> = problem.add_all(input.variables.iter().map_into());
    let mapping = input
        .variables
        .iter()
        .map(|v| v.name.as_ref())
        .zip(vars.iter().copied())
        .collect::<Vec<_>>();
    let objective = to_expr(&mapping, input.objective_offset, input.objective);
    let mut problem = match input.direction {
        Direction::Min => problem.minimise(objective),
        Direction::Max => problem.maximise(objective),
    }
    .using(highs);
    problem.set_verbose(true);
    let solution =
        problem
            .with_all(
                input.constraints.into_iter().enumerate().map(|(i, c)| {
                    constraint!(to_expr(&mapping, input.constraint_offsets[i], c) <= 0)
                }),
            )
            .with_all(
                input.equalities.into_iter().enumerate().map(|(i, c)| {
                    constraint!(to_expr(&mapping, input.equalities_offsets[i], c) == 0)
                }),
            )
            .solve();

    let res = match solution {
        Ok(sol) => MessageSolution::optimal(vars.into_iter().map(|v| sol.value(v)).collect()),
        Err(err) => match err {
            good_lp::ResolutionError::Unbounded => MessageSolution::unbounded(),
            good_lp::ResolutionError::Infeasible => MessageSolution::infeasible(),
            good_lp::ResolutionError::Other(e) => {
                eprintln!("{e}");
                return std::ptr::null();
            }
            good_lp::ResolutionError::Str(e) => {
                eprintln!("{e}");
                return std::ptr::null();
            }
        },
    };

    let Ok(json) = serde_json::to_string(&res) else {
        eprintln!("could not serialise solution");
        return std::ptr::null();
    };
    let Ok(c_string) = CString::new(json) else {
        eprintln!("Error: CString conversion failed (internal null bytes detected).");
        return std::ptr::null();
    };
    c_string.into_raw()
}

/// Frees a string allocated by [`solve`].
///
/// # Safety
/// This may only be called for pointers returend from [`solve`], and it may
/// only be done once per pointer.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn free(s: *mut c_char) {
    if s.is_null() {
        return;
    }
    unsafe {
        let _ = CString::from_raw(s);
    }
}

fn to_expr(vars: &Vec<(&str, Variable)>, off: f64, coeff: Vec<CoeffVar>) -> Expression {
    off.into_expression()
        + coeff
            .into_iter()
            .map(|c| {
                c.factor
                    * vars
                        .iter()
                        .find_map(|(name, v)| (*name == c.name).then_some(*v))
                        .expect("bad coeff")
            })
            .sum::<Expression>()
}
pub trait MapIntoExt: Iterator {
    /// Performs `.map(|x| x.into())`
    fn map_into<U>(self) -> std::iter::Map<Self, fn(Self::Item) -> U>
    where
        Self: Sized,
        Self::Item: Into<U>,
    {
        self.map(Into::into)
    }
}
impl<I> MapIntoExt for I where I: Iterator {}
