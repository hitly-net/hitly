'use client'

import { useActionState } from 'react'
import { updateProjectConfig, type ProjectConfigSaveState } from '@/actions/projects'

const fieldClass =
  'h-10 w-full rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900'
const areaClass =
  'min-h-20 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900'

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs text-zinc-500">{hint}</p> : null}
    </div>
  )
}

export type ProjectConfigFormProps = {
  projectId: string
  plugin: string
  name: string
  description: string
  defaultSlaMinutes: string
  defaultAssigneeUserId: string | null
  people: Array<{ userId: string; name: string; email: string }>
  origin: { baseUrl: string; address: string; namespace: string; taskQueue: string }
  evidenceSinkType: 'none' | 'http' | 's3'
  sink: {
    url: string
    endpoint: string
    region: string
    bucket: string
    prefix: string
    forcePathStyle: boolean | undefined
  }
}

export function ProjectConfigForm(props: ProjectConfigFormProps) {
  const initialState: ProjectConfigSaveState = { status: 'idle' }
  const [state, formAction, pending] = useActionState(
    updateProjectConfig.bind(null, props.projectId),
    initialState,
  )
  // The stored timeout only shapes requests with no explicit deadline; make
  // the units and the 24h default visible (PM ruling on the "60" field).
  const slaValue = props.defaultSlaMinutes && props.defaultSlaMinutes !== '0' ? props.defaultSlaMinutes : ''

  return (
    <form action={formAction} className="mt-6 flex max-w-xl flex-col gap-3">
      <Field id="project-name" label="Project name">
        <input id="project-name" name="name" defaultValue={props.name} className={fieldClass} />
      </Field>
      <Field id="project-description" label="Description">
        <textarea
          id="project-description"
          name="description"
          defaultValue={props.description}
          className={areaClass}
        />
      </Field>
      <Field
        id="project-sla"
        label="Request timeout (minutes)"
        hint="Applies only to requests that do not set their own deadline. Blank = 24 hours (1440 minutes). ask_user and request_approval default to 24h unless you set a value here."
      >
        <input
          id="project-sla"
          name="sla"
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          defaultValue={slaValue}
          placeholder="1440 (24 hours)"
          className={fieldClass}
        />
      </Field>
      <Field id="project-assignee" label="Default assignee">
        <select
          id="project-assignee"
          name="defaultAssigneeUserId"
          defaultValue={props.defaultAssigneeUserId ?? ''}
          className={fieldClass}
        >
          <option value="">No default assignee</option>
          {props.people.map((person) => (
            <option key={person.userId} value={person.userId}>
              {person.name} ({person.email})
            </option>
          ))}
        </select>
      </Field>

      <Field
        id="project-baseurl"
        label={props.plugin === 'temporal' ? 'Temporal address' : 'Origin base URL'}
      >
        <input id="project-baseurl" name="baseUrl" defaultValue={props.origin.baseUrl} className={fieldClass} />
      </Field>
      {props.plugin === 'temporal' ? (
        <>
          <Field id="project-address" label="Workflow address">
            <input id="project-address" name="address" defaultValue={props.origin.address} className={fieldClass} />
          </Field>
          <Field id="project-namespace" label="Temporal namespace">
            <input
              id="project-namespace"
              name="namespace"
              defaultValue={props.origin.namespace}
              placeholder="default"
              className={fieldClass}
            />
          </Field>
          <Field id="project-taskqueue" label="Task queue">
            <input
              id="project-taskqueue"
              name="taskQueue"
              defaultValue={props.origin.taskQueue}
              className={fieldClass}
            />
          </Field>
        </>
      ) : (
        <Field
          id="project-token"
          label="Mastra / origin HTTP token"
          hint="Secret. Leave blank to keep the stored token - saving never overwrites it with blank."
        >
          <input id="project-token" name="token" type="password" defaultValue="" className={fieldClass} />
        </Field>
      )}

      <h3 className="mt-4 text-sm font-semibold">Evidence Storage</h3>
      <p className="text-xs text-zinc-500">
        Evidence is written to your URL. HITLy keeps a receipt only. Decide will not resume the origin if this URL fails.
      </p>
      <Field id="project-sink-type" label="Sink type">
        <select id="project-sink-type" name="evidenceSinkType" defaultValue={props.evidenceSinkType} className={fieldClass}>
          <option value="none">None</option>
          <option value="http">HTTP</option>
          <option value="s3">S3</option>
        </select>
      </Field>
      <Field id="project-sink-url" label="Evidence sink URL">
        <input id="project-sink-url" name="evidenceSinkUrl" defaultValue={props.sink.url} className={fieldClass} />
      </Field>
      <Field
        id="project-sink-auth"
        label="Authorization header"
        hint="Secret. Leave blank to keep the stored value."
      >
        <input id="project-sink-auth" name="evidenceSinkAuthHeader" type="password" defaultValue="" className={fieldClass} />
      </Field>
      <Field
        id="project-sink-headers"
        label="Custom headers"
        hint="Optional, one per line like X-Store-Token: abc123. Transport-only, not stored in the evidence event."
      >
        <textarea id="project-sink-headers" name="evidenceSinkHeaders" defaultValue="" className={areaClass} />
      </Field>
      <Field
        id="project-sink-metadata"
        label="Metadata JSON"
        hint='Optional JSON object sent as X-Hitly-Metadata with each evidence POST. Transport-only. Example: {"tenant":"acme","bucket":"audit"}'
      >
        <textarea id="project-sink-metadata" name="evidenceSinkMetadata" defaultValue="" className={areaClass} />
      </Field>

      <h3 className="mt-4 text-sm font-semibold">S3 Configuration</h3>
      <p className="text-xs text-zinc-500">
        For S3 sink type. Supports AWS S3, Cloudflare R2, Garage, and on-premises S3-compatible storage (Ceph, Cloudian).
      </p>
      <Field id="project-s3-endpoint" label="S3 endpoint" hint="e.g., http://127.0.0.1:3902">
        <input id="project-s3-endpoint" name="evidenceSinkS3Endpoint" defaultValue={props.sink.endpoint} className={fieldClass} />
      </Field>
      <Field id="project-s3-region" label="S3 region" hint="e.g., local, us-east-1, eu-west-1, auto">
        <input id="project-s3-region" name="evidenceSinkS3Region" defaultValue={props.sink.region} className={fieldClass} />
      </Field>
      <Field id="project-s3-bucket" label="S3 bucket name" hint="e.g., evidence">
        <input id="project-s3-bucket" name="evidenceSinkS3Bucket" defaultValue={props.sink.bucket} className={fieldClass} />
      </Field>
      <Field id="project-s3-access-key" label="S3 access key ID" hint="Secret. Leave blank to keep the stored value.">
        <input id="project-s3-access-key" name="evidenceSinkS3AccessKeyId" defaultValue="" className={fieldClass} />
      </Field>
      <Field id="project-s3-secret-key" label="S3 secret access key" hint="Secret. Leave blank to keep the stored value.">
        <input id="project-s3-secret-key" name="evidenceSinkS3SecretAccessKey" type="password" defaultValue="" className={fieldClass} />
      </Field>
      <Field id="project-s3-prefix" label="S3 key prefix" hint="Optional, e.g., hitly/">
        <input id="project-s3-prefix" name="evidenceSinkS3Prefix" defaultValue={props.sink.prefix} className={fieldClass} />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        {/* Unchecked boxes submit nothing; the hidden pre-value makes an
            explicit uncheck persist as false. */}
        <input type="hidden" name="evidenceSinkS3ForcePathStyle" value="false" />
        <input
          type="checkbox"
          name="evidenceSinkS3ForcePathStyle"
          defaultChecked={
            props.sink.forcePathStyle === true ||
            (props.sink.forcePathStyle !== false &&
              typeof props.sink.endpoint === 'string' &&
              !props.sink.endpoint.includes('amazonaws.com'))
          }
          className="h-4 w-4"
        />
        Force path-style URLs (defaults to on for non-AWS endpoints)
      </label>

      <div className="sticky bottom-0 -mx-1 mt-2 flex items-center gap-3 border-t border-zinc-200 bg-zinc-50/95 px-1 py-3 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/95">
        <button
          type="submit"
          disabled={pending}
          className="h-10 rounded-md bg-zinc-900 px-6 text-sm font-medium text-white disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {pending ? 'Saving…' : 'Save changes'}
        </button>
        {state.status === 'saved' ? (
          <span role="status" className="text-sm font-medium text-green-700 dark:text-green-400">
            Saved
          </span>
        ) : null}
        {state.status === 'error' ? (
          <span role="alert" className="text-sm font-medium text-red-700 dark:text-red-400">
            {state.error ?? 'Save failed'}
          </span>
        ) : null}
      </div>
    </form>
  )
}
