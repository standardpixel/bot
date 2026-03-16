/**
 * Slack Block Kit modal definitions for scheduling
 */

/**
 * Get schedule creation/edit modal
 * @param {Object} existingSchedule - Optional existing schedule for editing
 * @returns {Object} Slack modal view object
 */
function getScheduleModal(existingSchedule = null) {
  const isEdit = !!existingSchedule;

  return {
    type: "modal",
    callback_id: isEdit ? "edit_schedule_modal_submit" : "schedule_modal_submit",
    title: {
      type: "plain_text",
      text: isEdit ? "Edit Schedule" : "Schedule Task"
    },
    submit: {
      type: "plain_text",
      text: isEdit ? "Update" : "Create"
    },
    close: {
      type: "plain_text",
      text: "Cancel"
    },
    private_metadata: isEdit ? existingSchedule.id : "",
    blocks: [
      {
        type: "input",
        block_id: "prompt_block",
        label: {
          type: "plain_text",
          text: "What should I do?"
        },
        element: {
          type: "plain_text_input",
          action_id: "prompt_input",
          multiline: true,
          initial_value: existingSchedule?.prompt || "",
          placeholder: {
            type: "plain_text",
            text: "e.g., Run my daily briefing"
          }
        }
      },
      {
        type: "input",
        block_id: "time_block",
        label: {
          type: "plain_text",
          text: "Time (HH:MM in 24-hour format)"
        },
        element: {
          type: "plain_text_input",
          action_id: "time_input",
          initial_value: existingSchedule?.time || "",
          placeholder: {
            type: "plain_text",
            text: "08:00"
          }
        }
      },
      {
        type: "input",
        block_id: "recurrence_block",
        label: {
          type: "plain_text",
          text: "Recurrence"
        },
        element: {
          type: "static_select",
          action_id: "recurrence_select",
          initial_option: existingSchedule ? {
            text: { type: "plain_text", text: getRecurrenceLabel(existingSchedule.recurrence) },
            value: existingSchedule.recurrence
          } : undefined,
          placeholder: {
            type: "plain_text",
            text: "Select frequency"
          },
          options: [
            {
              text: { type: "plain_text", text: "One-time" },
              value: "once"
            },
            {
              text: { type: "plain_text", text: "Daily" },
              value: "daily"
            },
            {
              text: { type: "plain_text", text: "Weekdays (Mon-Fri)" },
              value: "weekdays"
            },
            {
              text: { type: "plain_text", text: "Weekly" },
              value: "weekly"
            },
            {
              text: { type: "plain_text", text: "Monthly" },
              value: "monthly"
            }
          ]
        }
      },
      {
        type: "input",
        block_id: "date_block",
        optional: true,
        label: {
          type: "plain_text",
          text: "Date (for one-time, weekly, or monthly)"
        },
        hint: {
          type: "plain_text",
          text: "For weekly: sets day of week. For monthly: sets day of month."
        },
        element: {
          type: "datepicker",
          action_id: "date_picker",
          initial_date: existingSchedule?.startDate || undefined,
          placeholder: {
            type: "plain_text",
            text: "Select a date"
          }
        }
      }
    ]
  };
}

/**
 * Get manage schedules modal
 * @param {Array} schedules - User's schedules
 * @returns {Object} Slack modal view object
 */
function getManageSchedulesModal(schedules) {
  const blocks = [];

  if (schedules.length === 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "You don't have any scheduled tasks yet."
      }
    });
  } else {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Your Scheduled Tasks*"
      }
    });

    blocks.push({
      type: "divider"
    });

    schedules.forEach((schedule) => {
      const recurrenceText = getRecurrenceLabel(schedule.recurrence);
      const statusEmoji = schedule.enabled ? "✅" : "⏸️";
      const nextRunText = schedule.nextRun
        ? `Next run: ${new Date(schedule.nextRun).toLocaleString()}`
        : "Not scheduled";

      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${statusEmoji} *${schedule.prompt}*\n⏰ ${schedule.time} - ${recurrenceText}\n📅 ${nextRunText}`
        }
      });

      blocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Edit"
            },
            action_id: `edit_schedule_${schedule.id}`,
            value: schedule.id
          },
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Delete"
            },
            action_id: `delete_schedule_${schedule.id}`,
            value: schedule.id,
            style: "danger",
            confirm: {
              title: {
                type: "plain_text",
                text: "Delete Schedule"
              },
              text: {
                type: "mrkdwn",
                text: `Are you sure you want to delete this schedule?\n\n*${schedule.prompt}*`
              },
              confirm: {
                type: "plain_text",
                text: "Delete"
              },
              deny: {
                type: "plain_text",
                text: "Cancel"
              }
            }
          }
        ]
      });

      blocks.push({
        type: "divider"
      });
    });
  }

  return {
    type: "modal",
    callback_id: "manage_schedules_modal",
    title: {
      type: "plain_text",
      text: "Manage Schedules"
    },
    close: {
      type: "plain_text",
      text: "Close"
    },
    blocks: blocks
  };
}

/**
 * Helper function to get human-readable recurrence label
 */
function getRecurrenceLabel(recurrence) {
  const labels = {
    once: "One-time",
    daily: "Daily",
    weekdays: "Weekdays (Mon-Fri)",
    weekly: "Weekly",
    monthly: "Monthly"
  };
  return labels[recurrence] || recurrence;
}

module.exports = {
  getScheduleModal,
  getManageSchedulesModal
};
