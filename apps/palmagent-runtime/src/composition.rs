use crate::modules::routines::{
    adapters::{
        inbound::http::{Action, Message},
        outbound::hosts::Hosts,
    },
    application::{Error, Service},
};
use crate::platform::telemetry::Measurements;
use serde_json::json;
use tokio::sync::mpsc;

pub struct ObservationContext {
    pub instance: String,
    pub measurements: Measurements,
}

pub fn run_owner(
    mut service: Service,
    mut receiver: mpsc::Receiver<Message>,
    sender: mpsc::Sender<Message>,
    hosts: Hosts,
    runtime: tokio::runtime::Handle,
    observations: ObservationContext,
) {
    let ObservationContext {
        instance,
        measurements,
    } = observations;
    let mut workers = 0usize;
    while let Some(message) = receiver.blocking_recv() {
        measurements.tick(service.active());
        let mut jobs = Vec::new();
        match message {
            Message::Shutdown => service.stopping = true,
            Message::Completed(completion) => {
                workers -= 1;
                service.complete(completion);
                if !service.stopping {
                    let timing = measurements.begin("routine.poll");
                    jobs.extend(service.poll(false));
                    measurements.finish(timing, true);
                }
            }
            Message::Tick => {
                if !service.stopping {
                    let timing = measurements.begin("routine.poll");
                    jobs.extend(service.poll(true));
                    measurements.finish(timing, true);
                }
            }
            Message::Request(action, response, queue) => {
                measurements.finish(queue, !service.stopping);
                let timing = action.operation().and_then(|name| measurements.begin(name));
                if service.stopping {
                    measurements.finish(timing, false);
                    let _ = response.send(Err(Error::busy()));
                    continue;
                }
                let result = match action {
                    Action::Status => Ok(
                        json!({"protocol":1,"version":env!("PALMAGENT_PRODUCT_VERSION"),"sourceCommit":env!("PALMAGENT_SOURCE_COMMIT"),"instance":instance,"revision":service.revision,"activeScripts":service.active(),"stopping":service.stopping,"telemetry":measurements.snapshot()}),
                    ),
                    Action::List => service.list(),
                    Action::Get(id) => service.get(&id).map(|routine| json!({"routine":routine})),
                    Action::Create(value) => service.create(value),
                    Action::Update(id, value) => service.update(&id, value),
                    Action::Remove(id) => service.remove(&id),
                    Action::Runs(id) => service.runs(&id),
                    Action::Run(id) => service.run(&id).map(|(value, admitted)| {
                        jobs.extend(admitted);
                        value
                    }),
                    Action::Stop(id) => service.stop(&id).map(|stops| {
                        jobs.extend(stops);
                        json!({"pending":service.has_pending(&id)})
                    }),
                    Action::Pending(id) => service.get(&id).map(
                        |routine| json!({"routine":routine,"pending":service.has_pending(&id)}),
                    ),
                };
                measurements.finish(timing, result.is_ok());
                let _ = response.send(result);
            }
        }
        // Hold the owner lock until every launched worker settles. Otherwise an
        // old launch could race the next owner's retained-admission inspection.
        if service.stopping && workers == 0 {
            break;
        }
        for job in jobs {
            workers += 1;
            let host = hosts.clone();
            let send = sender.clone();
            runtime.spawn_blocking(move || {
                let result = host.execute(job);
                let _ = send.blocking_send(Message::Completed(result));
            });
        }
    }
}
